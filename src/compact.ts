/**
 * The adapter: turn Pi's compaction preparation into our summary.
 *
 * Two things happen here beyond calling the serializer.
 *
 * 1. **Snap to a whole turn.** Pi's cut is token-denominated and its
 *    `isCutPointMessage` includes `assistant` while `isTurnStartMessage` does
 *    not, so the cut usually lands mid-turn and `isSplitTurn` fires. That
 *    LLM-summarises the early part of the current turn while keeping the rest
 *    verbatim — a turn straddling two representations, which is the precision
 *    loss the paper's Algorithm 1 avoids by cutting on turn boundaries. Snapping
 *    backwards to the enclosing turn start fixes it, and is nearly free because
 *    Pi already excludes the turn prefix from `messagesToSummarize` when split.
 *
 * 2. **Carry the file map.** Pi inherits `readFiles`/`modifiedFiles` across its
 *    own compactions, but `extractFileOperations()` skips a previous compaction
 *    when `fromHook` is true. Ours always is, so we carry them ourselves — using
 *    Pi's own top-level shape so the lists survive a switch in either direction.
 */

import type { CliffConfig } from "./config.ts";
import { type SerializationStats, messageChars, renderSummary } from "./serialize.ts";
import type { AnyMsg } from "./types.ts";

/** Structural mirror of Pi's `CompactionPreparation` (not a public export). */
export interface Preparation {
	readonly firstKeptEntryId: string;
	readonly messagesToSummarize: readonly AnyMsg[];
	readonly turnPrefixMessages: readonly AnyMsg[];
	readonly isSplitTurn: boolean;
	readonly tokensBefore: number;
	/** Raw from Pi: `{read, written, edited}` Sets. `unknown` on purpose — the
	 *  shape is not part of Pi's public exports and must be tolerated either way. */
	readonly fileOps?: unknown;
}

/** One entry on the current path, reduced to what the cut decision needs. */
export interface CutCandidate {
	readonly id: string;
	/** The entry's projected messages include a turn-start role. */
	readonly startsTurn: boolean;
	/** A prior compaction: never snap to it or past it. */
	readonly isCompactionBoundary?: boolean;
}

export type SnapReason = "not-split" | "snapped" | "overshoot-exceeded" | "no-turn-start";

export interface SnapDecision {
	readonly snap: boolean;
	readonly reason: SnapReason;
	/** Tokens we would additionally keep by snapping. */
	readonly overshootTokens: number;
}

/**
 * Index of the nearest turn start at or before `fromIndex`, or -1.
 *
 * Stops at a compaction boundary rather than crossing it: snapping past a prior
 * compaction would pull its summary into the kept region, which is the one thing
 * the algorithm must never do.
 */
export function enclosingTurnStartIndex(
	candidates: readonly CutCandidate[],
	fromIndex: number,
): number {
	for (let i = Math.min(fromIndex, candidates.length - 1); i >= 0; i--) {
		const c = candidates[i];
		if (!c) continue;
		if (c.isCompactionBoundary) return -1;
		if (c.startsTurn) return i;
	}
	return -1;
}

export function decideSnap(args: {
	readonly isSplitTurn: boolean;
	readonly overshootTokens: number;
	readonly turnStartId: string | null;
	readonly cfg: CliffConfig;
}): SnapDecision {
	if (!args.isSplitTurn) {
		return { snap: true, reason: "not-split", overshootTokens: 0 };
	}
	if (args.turnStartId === null) {
		return { snap: false, reason: "no-turn-start", overshootTokens: args.overshootTokens };
	}
	// Keeping a whole turn can push post-compaction context back over the
	// trigger, so cap the extra we accept and fall back to Pi's split cut.
	if (args.overshootTokens > args.cfg.maxTurnOvershoot) {
		return { snap: false, reason: "overshoot-exceeded", overshootTokens: args.overshootTokens };
	}
	return { snap: true, reason: "snapped", overshootTokens: args.overshootTokens };
}

/** `/compact <instructions>` focuses a summary; truncation cannot honour that. */
export function shouldDeferToPi(args: {
	readonly reason: string;
	readonly customInstructions?: string | undefined;
	readonly cfg: CliffConfig;
}): boolean {
	if (!args.cfg.honorManualInstructions) return false;
	if (args.reason !== "manual") return false;
	return typeof args.customInstructions === "string" && args.customInstructions.trim().length > 0;
}

// --- details -----------------------------------------------------------------

export interface CliffDetails {
	/** Pi's own field names, at the top level, so lists survive either direction. */
	readonly readFiles: string[];
	readonly modifiedFiles: string[];
	readonly cliffcompaction: {
		readonly version: number;
		readonly snap: SnapReason;
		readonly stats: SerializationStats;
	};
}

interface FileLists {
	readonly readFiles?: readonly string[];
	readonly modifiedFiles?: readonly string[];
}

interface ResolvedFileLists {
	readonly readFiles: string[];
	readonly modifiedFiles: string[];
}

/** Only the two real shapes: a Set (Pi's `FileOperations`) or an array (our
 *  `details`). A bare string is malformed input, not a one-element list. */
function stringsFrom(v: unknown): string[] {
	if (v instanceof Set) return [...v].filter((x): x is string => typeof x === "string" && x.length > 0);
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0);
	return [];
}

/**
 * Normalise Pi's `FileOperations` (`{read, written, edited}` Sets) and our own
 * array form into one shape. Both are accepted so a carried list and a fresh
 * `fileOps` can be merged without the caller caring which is which.
 */
export function fileOpsToLists(fileOps: unknown): FileLists {
	if (!fileOps || typeof fileOps !== "object") return {};
	const o = fileOps as Record<string, unknown>;
	const read = [...stringsFrom(o.read), ...stringsFrom(o.readFiles)];
	const modified = [
		...stringsFrom(o.written),
		...stringsFrom(o.edited),
		...stringsFrom(o.modifiedFiles),
	];
	if (read.length === 0 && modified.length === 0) return {};
	return { readFiles: read, modifiedFiles: modified };
}

/** Tolerant: an unknown or foreign `details` shape yields empty lists. */
export function readFileLists(details: unknown): ResolvedFileLists {
	if (!details || typeof details !== "object") return { readFiles: [], modifiedFiles: [] };
	const d = details as Record<string, unknown>;
	return { readFiles: stringsFrom(d.readFiles), modifiedFiles: stringsFrom(d.modifiedFiles) };
}

/**
 * Merge every list, then apply Pi's own convention: a file that was modified is
 * not also reported as read, and both lists are sorted. Matching Pi exactly
 * matters because the model has seen this shape from every native compaction.
 *
 * Inputs may be partial — Pi reports read, written and edited independently.
 */
export function finalizeFileLists(...lists: readonly (FileLists | undefined | null)[]): ResolvedFileLists {
	const read = new Set<string>();
	const modified = new Set<string>();
	for (const l of lists) {
		if (!l) continue;
		for (const f of l.readFiles ?? []) read.add(f);
		for (const f of l.modifiedFiles ?? []) modified.add(f);
	}
	return {
		readFiles: [...read].filter((f) => !modified.has(f)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

// --- planning ----------------------------------------------------------------

export interface PlanInput {
	readonly prep: Preparation;
	/** Current path entries, in order. */
	readonly cutCandidates: readonly CutCandidate[];
	readonly cfg: CliffConfig;
	/** `details` from the previous compaction on this path, if any. */
	readonly prevDetails?: unknown;
	/** Pi's `estimateTokens` in production; a chars/4 proxy in tests. */
	readonly estimate?: (m: AnyMsg) => number;
}

export interface PlannedCompaction {
	readonly summary: string;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
	readonly details: CliffDetails;
	readonly snap: SnapDecision;
	readonly stats: SerializationStats;
	/** Which messages went into the digest: history only, or history + prefix. */
	readonly summarizedMessages: number;
}

function defaultEstimate(m: AnyMsg): number {
	return Math.ceil(messageChars(m) / 4);
}

/** Build the compaction content, deciding the cut on the way. */
export function planCompaction(input: PlanInput): PlannedCompaction {
	const { prep, cfg } = input;
	const estimate = input.estimate ?? defaultEstimate;

	const cutIndex = findIndexById(input.cutCandidates, prep.firstKeptEntryId);

	// A non-split cut is already a turn start (Pi defines `isSplitTurn` as
	// `!startsTurn && turnStartIndex !== -1`), so only a split can move the cut.
	// Doing the lookup unconditionally would walk a healthy cut backwards.
	let turnStartId: string | null;
	if (prep.isSplitTurn) {
		const idx = cutIndex >= 0 ? enclosingTurnStartIndex(input.cutCandidates, cutIndex) : -1;
		turnStartId = idx >= 0 ? (input.cutCandidates[idx]?.id ?? null) : null;
	} else {
		turnStartId = prep.firstKeptEntryId;
	}

	let overshootTokens = 0;
	for (const m of prep.turnPrefixMessages) overshootTokens += estimate(m);

	const snap = decideSnap({
		isSplitTurn: prep.isSplitTurn,
		overshootTokens,
		turnStartId,
		cfg,
	});

	// Snapping keeps the whole turn, so the prefix must not also be summarised.
	// Not snapping means Pi keeps from its own cut, so the prefix must be.
	const messages: AnyMsg[] = snap.snap
		? [...prep.messagesToSummarize]
		: [...prep.messagesToSummarize, ...prep.turnPrefixMessages];

	const firstKeptEntryId = snap.snap && turnStartId ? turnStartId : prep.firstKeptEntryId;

	const files = finalizeFileLists(readFileLists(input.prevDetails), fileOpsToLists(prep.fileOps));
	const { summary, stats } = renderSummary(messages, cfg, files);

	return {
		summary,
		firstKeptEntryId,
		tokensBefore: prep.tokensBefore,
		details: {
			readFiles: files.readFiles,
			modifiedFiles: files.modifiedFiles,
			cliffcompaction: { version: 1, snap: snap.reason, stats },
		},
		snap,
		stats,
		summarizedMessages: messages.length,
	};
}

function findIndexById(candidates: readonly CutCandidate[], id: string): number {
	return candidates.findIndex((c) => c.id === id);
}
