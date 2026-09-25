/**
 * Serializer behaviour: content-class policy, the truncate-only contract, and
 * the properties the paper depends on.
 *
 * Fixtures are shaped after real Pi session entries (a `read` of a source file,
 * a `bash` test run, a short result, an error) rather than invented shapes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG, resolveConfig, type CliffConfigInput } from "./config.ts";
import {
	SUMMARY_HEADER,
	canonicalJson,
	excerpt,
	renderSummary,
	serializeConversation,
	truncate,
} from "./serialize.ts";
import type { AssistantMsg, ContentBlock, ToolResultMsg, UserMsg } from "./types.ts";

const cfg = (over: CliffConfigInput = {}) => resolveConfig(over);

const user = (text: string): UserMsg => ({ role: "user", content: text });

const assistant = (blocks: ContentBlock[]): AssistantMsg => ({ role: "assistant", content: blocks });

const result = (
	toolName: string,
	text: string,
	opts: { isError?: boolean; details?: Record<string, unknown> } = {},
): ToolResultMsg => ({
	role: "toolResult",
	toolCallId: `call_${toolName}`,
	toolName,
	content: [{ type: "text", text }],
	isError: opts.isError ?? false,
	...(opts.details ? { details: opts.details } : {}),
});

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const thinking = (t: string): ContentBlock => ({ type: "thinking", thinking: t });
const call = (name: string, args: Record<string, unknown>): ContentBlock => ({
	type: "toolCall",
	id: `id_${name}`,
	name,
	arguments: args,
});

// --- primitives -------------------------------------------------------------

test("truncate treats 0 as unlimited", () => {
	assert.equal(truncate("abcdef", 0), "abcdef");
	assert.equal(truncate("abcdef", -1), "abcdef");
	assert.equal(truncate("abcdef", 3), "abc...");
	assert.equal(truncate("abc", 3), "abc");
});

test("excerpt keeps both ends and counts what it removed", () => {
	const e = excerpt("A".repeat(100) + "TAIL", 10, 4);
	assert.ok(e.startsWith("AAAAAAAAAA"));
	assert.ok(e.endsWith("TAIL"));
	assert.ok(e.includes("[... 90 chars omitted ...]"));
});

test("excerpt is a no-op when the text already fits", () => {
	assert.equal(excerpt("short", 300, 200), "short");
});

test("canonicalJson is independent of key order", () => {
	assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

// --- content classes --------------------------------------------------------

test("long tool result from a re-runnable tool is dropped, signature kept", () => {
	const c = cfg();
	const msgs = [
		user("fix the build"),
		assistant([call("read", { path: "src/big.ts" })]),
		result("read", "X".repeat(5000)),
	];
	const out = serializeConversation(msgs, c);
	assert.ok(out.includes('[read] {"path":"src/big.ts"}'), "call signature survives");
	assert.ok(!out.includes("XXXX"), "no part of the dropped output survives");
	assert.ok(!out.includes("result:"), "a dropped result emits no line at all");
});

test("long tool result from a side-effecting tool is excerpted, not dropped", () => {
	const c = cfg();
	const body = "start-of-output\n" + "M".repeat(4000) + "\nfailure: assertion at line 42";
	const out = serializeConversation(
		[assistant([call("bash", { command: "pytest -x" })]), result("bash", body)],
		c,
	);
	assert.ok(out.includes("result: start-of-output"), "head retained");
	assert.ok(out.includes("failure: assertion at line 42"), "tail retained (exit status lives here)");
	assert.ok(out.includes("chars omitted"));
	assert.ok(!out.includes("M".repeat(600)), "the middle is gone");
});

test("short tool results are kept verbatim regardless of tool class", () => {
	const out = serializeConversation([result("read", "42 lines, no matches")], cfg());
	assert.ok(out.includes("result: 42 lines, no matches"));
});

test("error results are never dropped or silently truncated away", () => {
	const c = cfg();
	const out = serializeConversation([result("read", "E".repeat(9000), { isError: true })], c);
	assert.ok(out.startsWith("error: "));
	assert.ok(out.includes("chars omitted"), "bounded, but signal preserved");
});

test("an unknown tool is excerpted rather than dropped", () => {
	const c = cfg();
	const out = serializeConversation([result("mystery_tool", "Z".repeat(3000))], c);
	assert.ok(out.includes("result: ZZZ"), "unknown tools keep their head");
	assert.ok(out.includes("chars omitted"));
});

test("tool classification is overridable per tool", () => {
	const c = cfg({ toolPolicy: { dropTools: ["bash"], excerptTools: ["read"] } });
	const dropped = serializeConversation([result("bash", "B".repeat(3000))], c);
	assert.ok(!dropped.includes("BBB"));
	const kept = serializeConversation([result("read", "R".repeat(3000))], c);
	assert.ok(kept.includes("result: RRR"));
});

// --- assistant content ------------------------------------------------------

test("thinking is kept as text, and its signature never appears", () => {
	const a: AssistantMsg = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "the mock is not reset between cases", thinkingSignature: "SIGNED_BLOB" },
			text("step 0"),
		],
	};
	const out = serializeConversation([a], cfg());
	assert.ok(out.includes("thinking: the mock is not reset between cases"));
	assert.ok(out.includes("assistant: step 0"));
	assert.ok(!out.includes("SIGNED_BLOB"));
});

test("thinking is capped per message by thinkingMaxChars", () => {
	const a = assistant([thinking("T".repeat(5000))]);
	const out = serializeConversation([a], cfg({ thinkingMaxChars: 2000 }));
	assert.ok(out.includes("T".repeat(2000) + "..."));
	assert.ok(!out.includes("T".repeat(2001)));
});

test("thinkingMaxChars 0 means unlimited", () => {
	const out = serializeConversation([assistant([thinking("T".repeat(5000))])], cfg({ thinkingMaxChars: 0 }));
	assert.ok(out.includes("T".repeat(5000)));
	assert.ok(!out.includes("..."));
});

test("thinkingMode drop removes the reasoning channel entirely", () => {
	const a = assistant([thinking("secret reasoning"), text("visible")]);
	const out = serializeConversation([a], cfg({ thinkingMode: "drop" }));
	assert.ok(!out.includes("secret reasoning"));
	assert.ok(out.includes("assistant: visible"));
});

test("assistant visible text is capped independently of thinking", () => {
	const a = assistant([thinking("KEEP-ME-INTACT"), text("V".repeat(4000))]);
	const out = serializeConversation([a], cfg({ thoughtMaxChars: 300, thinkingMaxChars: 0 }));
	assert.ok(out.includes("KEEP-ME-INTACT"));
	assert.ok(out.includes("V".repeat(300) + "..."));
});

// --- user and Pi-specific roles ---------------------------------------------

test("user text is verbatim and only capped by humanMaxChars", () => {
	const long = "IMPORTANT: use the staging database, never prod. " + "N".repeat(30_000);
	const out = serializeConversation([user(long)], cfg());
	assert.ok(out.startsWith("user: IMPORTANT: use the staging database, never prod."));
	assert.ok(out.length < long.length + 100, "capped by humanMaxChars");
});

test("a prior compaction summary is dropped, never folded forward", () => {
	const prior = { role: "compactionSummary", summary: "OLD SUMMARY TEXT", tokensBefore: 123 } as const;
	const out = serializeConversation([prior, user("continue")], cfg());
	assert.ok(!out.includes("OLD SUMMARY TEXT"));
	assert.ok(out.includes("user: continue"));
});

test("a branch summary is kept: it is the only carrier of that branch", () => {
	const b = { role: "branchSummary", summary: "tried approach A, abandoned it", fromId: "x" } as const;
	assert.ok(serializeConversation([b], cfg()).includes("branch: tried approach A"));
});

test("custom messages are kept, since they are injected context", () => {
	const c = { role: "custom", customType: "todo", content: "remaining: wire the menu" } as const;
	assert.ok(serializeConversation([c], cfg()).includes("custom: remaining: wire the menu"));
});

test("system messages are not folded in (Pi's checkpoint carries them)", () => {
	const s = { role: "system", content: "You are a coding agent." } as const;
	assert.equal(serializeConversation([s], cfg()), "");
});

test("images are dropped from the compacted region", () => {
	const withImage: UserMsg = {
		role: "user",
		content: [text("see the screenshot"), { type: "image", data: "AAAA", mimeType: "image/png" }],
	};
	const out = serializeConversation([withImage], cfg());
	assert.ok(out.includes("see the screenshot"));
	assert.ok(!out.includes("AAAA"));
});

test("bashExecution honours excludeFromContext", () => {
	const shown = { role: "bashExecution", command: "ls", output: "a\nb" } as const;
	assert.ok(serializeConversation([shown], cfg()).includes("bash: $ ls"));
	const hidden = { role: "bashExecution", command: "ls", output: "a", excludeFromContext: true } as const;
	assert.equal(serializeConversation([hidden], cfg()), "");
});

// --- assembly ---------------------------------------------------------------

test("renderSummary always carries the honest header", () => {
	const { summary } = renderSummary([user("hi")], cfg());
	assert.ok(summary.startsWith(SUMMARY_HEADER));
});

test("file tags are synthesised so an extension compaction keeps the file map", () => {
	const { summary } = renderSummary([user("hi")], cfg(), {
		readFiles: ["src/a.ts", "src/a.ts", "src/b.ts"],
		modifiedFiles: ["src/c.ts"],
	});
	assert.ok(summary.includes("<read-files>\nsrc/a.ts\nsrc/b.ts\n</read-files>"), "deduped, order preserved");
	assert.ok(summary.includes("<modified-files>\nsrc/c.ts\n</modified-files>"));
});

test("file tags are omitted when empty", () => {
	const { summary } = renderSummary([user("hi")], cfg(), { readFiles: [], modifiedFiles: [] });
	assert.ok(!summary.includes("<read-files>"));
});

test("stats account for what was dropped", () => {
	const c = cfg();
	const { stats } = renderSummary(
		[result("read", "X".repeat(4000)), result("bash", "Y".repeat(4000)), result("read", "ok")],
		c,
	);
	assert.equal(stats.dropped, 1);
	assert.equal(stats.excerpted, 1);
	assert.equal(stats.kept, 1);
	assert.equal(stats.droppedChars, 4000, "fully dropped");
	assert.equal(stats.excerptedChars, 4000 - 300 - 200, "middle removed from the excerpt");
	assert.ok(stats.originalChars > stats.emittedChars);
});

test("the default config matches the shipped policy", () => {
	assert.equal(DEFAULT_CONFIG.resultMaxChars, 500);
	assert.equal(DEFAULT_CONFIG.cmdMaxChars, 150);
	assert.equal(DEFAULT_CONFIG.thinkingMaxChars, 2000);
	assert.equal(DEFAULT_CONFIG.thresholdTokens, 250_000);
	assert.equal(DEFAULT_CONFIG.keepRecentTokens, 40_000);
	// Shadow is on until the operator turns it off.
	assert.equal(DEFAULT_CONFIG.shadow, true);
});
