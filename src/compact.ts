/**
 * The adapter: turn Pi's compaction preparation into our summary.
 *
 * Pi's cut is already at CliffCompaction's granularity. `findProjectedCutPoint`
 * cuts at user/assistant/bashExecution/custom messages and never at a tool
 * result, so an assistant message and its observations always stay together —
 * that is exactly the paper's "K turn pairs". Pi's token-denominated window is
 * therefore substituted for the paper's turn count without changing what a
 * "turn" means.
 *
 * Pi additionally reports `isSplitTurn` / `turnPrefixMessages` when the cut lands
 * inside a user-message span. That is not a structural split: it means the early
 * part of the *current task* belongs in the summary while the recent steps stay
 * verbatim, so both lists go into the digest in order.
 *
 * An earlier version of this file tried to "fix" the split by moving the cut back
 * to the enclosing turn start, on the theory that a turn straddling the
 * summary/verbatim boundary was a precision loss. A live session showed why that
 * is wrong: in an agent run the user-message span *is* the whole task, so its
 * turn start is the first message of the session and snapping keeps everything,
 * leaving nothing to summarise. The extension then fell back to Pi's LLM summary
 * — correct, but pointless. Cutting at Pi's own boundary is what actually works.
 *
 * The second job here is carrying the file map. Pi inherits
 * `readFiles`/`modifiedFiles` across its own compactions, but
 * `extractFileOperations()` skips a previous compaction when `fromHook` is true.
 * Ours always is, so we carry them ourselves — using Pi's own top-level shape so
 * the lists survive a switch in either direction.
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
		/** Pi's own flag, recorded for observability: the task's early part was
		 *  summarised while its recent steps stayed verbatim. */
		readonly split: boolean;
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
	readonly cfg: CliffConfig;
	/** `details` from the previous compaction on this path, if any. */
	readonly prevDetails?: unknown;
	/** Pi's `estimateTokens` in production; a chars/4 proxy in tests. Unused for
	 *  correctness — kept so callers can pass the host's estimator when needed. */
	readonly estimate?: (m: AnyMsg) => number;
}

export interface PlannedCompaction {
	readonly summary: string;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
	readonly details: CliffDetails;
	readonly stats: SerializationStats;
	/** How many messages went into the digest. */
	readonly summarizedMessages: number;
}

function defaultEstimate(m: AnyMsg): number {
	return Math.ceil(messageChars(m) / 4);
}

/** Build the compaction content from Pi's preparation. */
export function planCompaction(input: PlanInput): PlannedCompaction {
	const { prep, cfg } = input;

	// History first, then the early part of the current task, in order. Pi's cut
	// is used unchanged: it is already the boundary cliff wants.
	const messages: AnyMsg[] = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];

	const files = finalizeFileLists(readFileLists(input.prevDetails), fileOpsToLists(prep.fileOps));
	const { summary, stats } = renderSummary(messages, cfg, files);

	return {
		summary,
		firstKeptEntryId: prep.firstKeptEntryId,
		tokensBefore: prep.tokensBefore,
		details: {
			readFiles: files.readFiles,
			modifiedFiles: files.modifiedFiles,
			cliffcompaction: { version: 1, split: prep.isSplitTurn, stats },
		},
		stats,
		summarizedMessages: messages.length,
	};
}

/** Exported for the estimator's default, so tests can match it. */
export { defaultEstimate };
