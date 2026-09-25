/**
 * The serializer: the whole algorithm.
 *
 * Pi already provides every property CliffCompaction asks for except one.
 * `buildContextEntries()` keeps a compaction summary plus the verbatim tail from
 * `firstKeptEntryId`, the trigger is a token threshold, and the cut never lands
 * on a tool result — that is cliff's structure. The single non-cliff part is the
 * summary itself: Pi asks an LLM for an "update prompt to merge" over
 * `previousSummary`, which is the summary-of-summaries chain the paper exists to
 * avoid.
 *
 * So this module replaces the summary generator and nothing else. Two of the
 * paper's three design choices then hold by construction:
 *
 *  - "never compact a compaction": `prepareCompaction()` sets
 *    `boundaryStart = prevCompactionIndex + 1`, so `messagesToSummarize` already
 *    excludes the prior summary. We simply never read `previousSummary`, and
 *    drop any `compactionSummary` that reaches us anyway.
 *  - "only original content": every message here comes from the projection of a
 *    real session entry.
 *
 * Policy is truncate/drop only. Nothing is ever rephrased, so no drift can
 * accumulate across rounds.
 */

import type { CliffConfig } from "./config.ts";
import { classifyTool } from "./policy.ts";
import {
	type AnyMsg,
	type Content,
	type ContentBlock,
	contentBlocks,
	isToolResult,
	toolResultText,
} from "./types.ts";

/**
 * The marker that tells the model the context was truncated rather than
 * rewritten. Keep the wording stable: it is what makes the compaction honest,
 * and (in the proxy lineage) what makes a prior summary recognisable.
 */
export const SUMMARY_HEADER =
	"The following is a summary of your previous actions (long observations omitted):";

// --- primitives -------------------------------------------------------------

/** `max <= 0` means unlimited. Mirrors the upstream repo's convention. */
export function truncate(text: string, max: number): string {
	if (!max || max <= 0) return text;
	if (text.length <= max) return text;
	return text.slice(0, max) + "...";
}

/** Head and tail with an explicit count of what was removed. Used where a
 *  tool's output cannot be regenerated, so a silent drop would lose the exit
 *  code or the failing assertion at the end of a long run. */
export function excerpt(text: string, head: number, tail: number): string {
	const h = Math.max(0, head);
	const t = Math.max(0, tail);
	if (text.length <= h + t) return text;
	const omitted = text.length - h - t;
	const tailPart = t > 0 ? `\n${text.slice(-t)}` : "";
	return `${text.slice(0, h)}\n[... ${omitted} chars omitted ...]${tailPart}`;
}

/** Deterministic JSON, so a digest does not depend on key insertion order. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
		return out;
	}
	return value;
}

function blockText(b: ContentBlock): string | undefined {
	const v = (b as { text?: unknown }).text;
	return typeof v === "string" ? v : undefined;
}

function blockThinking(b: ContentBlock): string | undefined {
	const v = (b as { thinking?: unknown }).thinking;
	return typeof v === "string" ? v : undefined;
}

function blockCall(b: ContentBlock): { name: string; args: Record<string, unknown> } | undefined {
	if (b.type !== "toolCall") return undefined;
	const name = (b as { name?: unknown }).name;
	const args = (b as { arguments?: unknown }).arguments;
	if (typeof name !== "string") return undefined;
	return { name, args: (args && typeof args === "object" ? args : {}) as Record<string, unknown> };
}

/** `[bash] {"command":"pytest -x"}`, arguments capped. */
export function callSignature(name: string, args: Record<string, unknown>, cfg: CliffConfig): string {
	return `[${name}] ${truncate(canonicalJson(args), cfg.cmdMaxChars)}`;
}

// --- statistics (observability only; nothing branches on these) --------------

export interface SerializationStats {
	messages: number;
	kept: number;
	dropped: number;
	excerpted: number;
	originalChars: number;
	emittedChars: number;
	/** Chars of results discarded entirely. */
	droppedChars: number;
	/** Chars removed from results that were kept as an excerpt. */
	excerptedChars: number;
	thinkingTruncated: number;
}

function newStats(): SerializationStats {
	return {
		messages: 0,
		kept: 0,
		dropped: 0,
		excerpted: 0,
		originalChars: 0,
		emittedChars: 0,
		droppedChars: 0,
		excerptedChars: 0,
		thinkingTruncated: 0,
	};
}

// --- per-message digests ----------------------------------------------------

function serializeAssistant(m: AnyMsg, cfg: CliffConfig, stats: SerializationStats): string[] {
	const thinking: string[] = [];
	const texts: string[] = [];
	const sigs: string[] = [];

	for (const b of contentBlocks((m as { content?: Content }).content)) {
		if (b.type === "thinking") {
			if (cfg.thinkingMode === "drop") continue;
			const t = blockThinking(b);
			if (!t) continue;
			if (cfg.thinkingMaxChars > 0 && t.length > cfg.thinkingMaxChars) stats.thinkingTruncated++;
			thinking.push(t);
		} else if (b.type === "text") {
			const t = blockText(b);
			if (t) texts.push(t);
		} else {
			const call = blockCall(b);
			if (call) sigs.push(callSignature(call.name, call.args, cfg));
		}
	}

	const lines: string[] = [];
	// Signed thinking blocks are never re-sent from the compacted region — only
	// their text, and only as text. A signature without its block is unusable.
	const think = truncate(thinking.join("\n").trim(), cfg.thinkingMaxChars);
	if (think) lines.push(`thinking: ${think}`);
	const text = truncate(texts.join("\n").trim(), cfg.thoughtMaxChars);
	if (text) lines.push(`assistant: ${text}`);
	if (sigs.length > 0) lines.push(sigs.join("\n"));

	// One block per message keeps the digest readable and boundaries obvious.
	return lines.length > 0 ? [lines.join("\n")] : [];
}

function serializeUser(m: AnyMsg, cfg: CliffConfig, stats: SerializationStats): string[] {
	const parts: string[] = [];
	for (const b of contentBlocks((m as { content?: Content }).content)) {
		if (b.type === "text") {
			const raw = blockText(b) ?? "";
			// A prior summary reaching us here is dropped, never merged forward.
			if (raw.startsWith(SUMMARY_HEADER)) continue;
			const t = raw.trim();
			if (t) parts.push(`user: ${truncate(t, cfg.humanMaxChars)}`);
		} else if (b.type === "toolResult") {
			// Defensive: Pi models results as their own role, but a raw
			// Anthropic-shaped body can nest them in a user message.
			const text = toolResultText({ role: "toolResult", content: [b] } as AnyMsg).trim();
			if (text) parts.push(...serializeResultText(text, "?", false, cfg, stats));
		}
		// images and unknown blocks are dropped from the compacted region
	}
	return parts;
}

function serializeResultText(
	text: string,
	toolName: string,
	isError: boolean,
	cfg: CliffConfig,
	stats: SerializationStats,
): string[] {
	if (!text) return [];
	if (isError && cfg.toolPolicy.alwaysKeepErrors) {
		stats.kept++;
		if (text.length > cfg.resultMaxChars) {
			stats.excerptedChars += Math.max(0, text.length - cfg.excerptHead - cfg.excerptTail);
		}
		const body = text.length > cfg.resultMaxChars ? excerpt(text, cfg.excerptHead, cfg.excerptTail) : text;
		return [`error: ${body}`];
	}
	if (text.length <= cfg.resultMaxChars) {
		stats.kept++;
		return [`result: ${text}`];
	}
	switch (classifyTool(toolName, cfg.toolPolicy)) {
		case "drop":
			stats.dropped++;
			stats.droppedChars += text.length;
			// The call signature stays in the assistant block, and for a
			// re-runnable tool that is a full recovery path.
			return [];
		case "keep":
			stats.kept++;
			return [`result: ${text}`];
		default:
			stats.excerpted++;
			stats.excerptedChars += Math.max(0, text.length - cfg.excerptHead - cfg.excerptTail);
			return [`result: ${excerpt(text, cfg.excerptHead, cfg.excerptTail)}`];
	}
}

function serializeToolResult(m: AnyMsg, cfg: CliffConfig, stats: SerializationStats): string[] {
	if (!isToolResult(m)) return [];
	return serializeResultText(toolResultText(m).trim(), m.toolName, m.isError === true, cfg, stats);
}

function serializeBashExecution(m: AnyMsg, cfg: CliffConfig, stats: SerializationStats): string[] {
	const e = m as { command?: unknown; output?: unknown; excludeFromContext?: unknown; fullOutputPath?: unknown };
	if (e.excludeFromContext === true) return [];
	const command = typeof e.command === "string" ? e.command : "";
	const output = typeof e.output === "string" ? e.output.trim() : "";
	const lines: string[] = [`bash: $ ${command}`];
	if (output) {
		if (output.length <= cfg.resultMaxChars) lines.push(output);
		else {
			stats.excerpted++;
			stats.excerptedChars += Math.max(0, output.length - cfg.excerptHead - cfg.excerptTail);
			lines.push(excerpt(output, cfg.excerptHead, cfg.excerptTail));
		}
	}
	if (typeof e.fullOutputPath === "string" && e.fullOutputPath) {
		lines.push(`(full output: ${e.fullOutputPath})`);
	}
	return [lines.join("\n")];
}

/**
 * Serialize one message into zero or more digest blocks.
 *
 * Returned rather than joined so a mixed user message (human text plus a nested
 * result) keeps one prefix per part.
 */
export function serializeMessage(m: AnyMsg, cfg: CliffConfig, stats: SerializationStats): string[] {
	stats.messages++;
	stats.originalChars += rawChars(m);
	let out: string[];
	switch (m.role) {
		case "assistant":
			out = serializeAssistant(m, cfg, stats);
			break;
		case "user":
			out = serializeUser(m, cfg, stats);
			break;
		case "toolResult":
			out = serializeToolResult(m, cfg, stats);
			break;
		case "bashExecution":
			out = serializeBashExecution(m, cfg, stats);
			break;
		case "custom": {
			const t = plainText((m as { content?: Content }).content).trim();
			out = t ? [`custom: ${truncate(t, cfg.humanMaxChars)}`] : [];
			break;
		}
		case "branchSummary": {
			// The only carrier of the abandoned branch's context.
			const s = String((m as { summary?: unknown }).summary ?? "").trim();
			out = s ? [`branch: ${truncate(s, cfg.humanMaxChars)}`] : [];
			break;
		}
		case "compactionSummary":
			// Never compact a compaction. This is the enforcement point.
			out = [];
			break;
		default:
			// system messages are prompt state: Pi's compaction entry carries the
			// checkpoint, so folding them in here would duplicate it.
			out = [];
			break;
	}
	stats.emittedChars += out.reduce((n, s) => n + s.length, 0);
	return out;
}

function plainText(content: Content | undefined): string {
	const parts: string[] = [];
	for (const b of contentBlocks(content)) {
		const t = blockText(b);
		if (t) parts.push(t);
	}
	return parts.join("\n");
}

function rawChars(m: AnyMsg): number {
	const c = (m as { content?: Content }).content;
	if (typeof c === "string") return c.length;
	let n = 0;
	for (const b of contentBlocks(c)) {
		if (b.type === "image") n += String((b as { data?: unknown }).data ?? "").length;
		else {
			const t = blockText(b) ?? blockThinking(b);
			if (t) n += t.length;
			else n += canonicalJson(b).length;
		}
	}
	if (m.role === "bashExecution") n += String((m as { output?: unknown }).output ?? "").length;
	return n;
}

// --- assembly ---------------------------------------------------------------

export interface FileOps {
	readonly readFiles?: readonly string[];
	readonly modifiedFiles?: readonly string[];
}

export function renderFileTags(fileOps?: FileOps): string {
	const sections: string[] = [];
	const read = unique(fileOps?.readFiles);
	const modified = unique(fileOps?.modifiedFiles);
	if (read.length > 0) sections.push(`<read-files>\n${read.join("\n")}\n</read-files>`);
	if (modified.length > 0) sections.push(`<modified-files>\n${modified.join("\n")}\n</modified-files>`);
	return sections.join("\n\n");
}

function unique(xs?: readonly string[]): string[] {
	if (!xs) return [];
	return [...new Set(xs.filter((x) => typeof x === "string" && x.length > 0))];
}

/** The digest body, without the header or file tags. */
export function serializeConversation(
	messages: readonly AnyMsg[],
	cfg: CliffConfig,
	stats: SerializationStats = newStats(),
): string {
	const blocks: string[] = [];
	for (const m of messages) blocks.push(...serializeMessage(m, cfg, stats));
	return blocks.join("\n\n");
}

/** The full summary string Pi will persist as the compaction entry. */
export function renderSummary(
	messages: readonly AnyMsg[],
	cfg: CliffConfig,
	fileOps?: FileOps,
): { summary: string; stats: SerializationStats } {
	const stats = newStats();
	const body = serializeConversation(messages, cfg, stats);
	// The file tags are Pi's convention and are worth synthesising: an
	// extension-provided compaction (fromHook: true) does not inherit Pi's
	// cumulative file lists, so dropping them would lose the model's file map.
	const files = renderFileTags(fileOps);
	const summary = [SUMMARY_HEADER, body, files].filter((s) => s.length > 0).join("\n\n");
	return { summary, stats };
}
