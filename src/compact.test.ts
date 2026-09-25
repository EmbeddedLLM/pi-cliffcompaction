/**
 * Cut planning and the adapter's decision rules.
 *
 * A live session showed why the cut is used unchanged: Pi's cut already lands on
 * assistant-message boundaries, and moving it back to the enclosing turn start
 * keeps the whole user-message span — which in an agent run is the entire task,
 * leaving nothing to summarise. The regression is pinned below.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type Preparation,
	fileOpsToLists,
	finalizeFileLists,
	planCompaction,
	readFileLists,
	shouldDeferToPi,
} from "./compact.ts";
import { type CliffConfigInput, resolveConfig } from "./config.ts";
import type { AnyMsg, AssistantMsg, ToolResultMsg, UserMsg } from "./types.ts";

const cfg = (over: CliffConfigInput = {}) => resolveConfig(over);

const user = (t: string): UserMsg => ({ role: "user", content: t });
const assistant = (t: string): AssistantMsg => ({ role: "assistant", content: [{ type: "text", text: t }] });
const result = (tool: string, t: string): ToolResultMsg => ({
	role: "toolResult",
	toolCallId: "c",
	toolName: tool,
	content: [{ type: "text", text: t }],
	isError: false,
});

const prep = (over: Partial<Preparation> = {}): Preparation => ({
	firstKeptEntryId: "e2",
	messagesToSummarize: [user("task"), assistant("looking")],
	turnPrefixMessages: [],
	isSplitTurn: false,
	tokensBefore: 250_000,
	...over,
});

// --- deferral ---------------------------------------------------------------

test("/compact with instructions defers to Pi's LLM summariser", () => {
	assert.equal(shouldDeferToPi({ reason: "manual", customInstructions: "focus on auth", cfg: cfg() }), true);
});

test("/compact without instructions uses the mechanical digest", () => {
	assert.equal(shouldDeferToPi({ reason: "manual", customInstructions: "", cfg: cfg() }), false);
	assert.equal(shouldDeferToPi({ reason: "manual", customInstructions: "   ", cfg: cfg() }), false);
	assert.equal(shouldDeferToPi({ reason: "manual", customInstructions: undefined, cfg: cfg() }), false);
});

test("threshold and overflow compactions never defer", () => {
	assert.equal(shouldDeferToPi({ reason: "threshold", customInstructions: "x", cfg: cfg() }), false);
	assert.equal(shouldDeferToPi({ reason: "overflow", customInstructions: "x", cfg: cfg() }), false);
});

test("deferral can be disabled entirely", () => {
	const off = cfg({ honorManualInstructions: false });
	assert.equal(shouldDeferToPi({ reason: "manual", customInstructions: "focus", cfg: off }), false);
});

// --- file lists -------------------------------------------------------------

test("file lists are read from Pi's own details shape", () => {
	assert.deepEqual(readFileLists({ readFiles: ["a"], modifiedFiles: ["b"] }), {
		readFiles: ["a"],
		modifiedFiles: ["b"],
	});
});

test("a foreign or malformed details shape yields empty lists, never a throw", () => {
	for (const d of [null, undefined, 42, "x", {}, { readFiles: "a" }, { readFiles: [1, 2] }]) {
		assert.deepEqual(readFileLists(d), { readFiles: [], modifiedFiles: [] });
	}
});

test("Pi's FileOperations Sets are normalised", () => {
	const ops = { read: new Set(["a.ts", "b.ts"]), written: new Set(["c.ts"]), edited: new Set(["b.ts"]) };
	assert.deepEqual(finalizeFileLists(fileOpsToLists(ops)), {
		// b.ts was both read and edited, so it is reported as modified only.
		readFiles: ["a.ts"],
		modifiedFiles: ["b.ts", "c.ts"],
	});
});

test("a partial fileOps from Pi does not throw", () => {
	// read, written and edited are independent; any of them may be empty or absent.
	assert.deepEqual(fileOpsToLists({ read: new Set(["a"]) }), { readFiles: ["a"], modifiedFiles: [] });
	assert.deepEqual(fileOpsToLists({}), {});
	assert.deepEqual(fileOpsToLists(null), {});
	assert.deepEqual(fileOpsToLists("nonsense"), {});
});

test("carried lists merge, dedupe, sort and exclude modified from read", () => {
	const merged = finalizeFileLists(
		{ readFiles: ["b.ts", "a.ts"], modifiedFiles: ["x.ts"] },
		{ readFiles: ["b.ts", "c.ts"] },
	);
	assert.deepEqual(merged.readFiles, ["a.ts", "b.ts", "c.ts"]);
	assert.deepEqual(merged.modifiedFiles, ["x.ts"], "a partial input does not drop the other list");
	const overlap = finalizeFileLists({ readFiles: ["a.ts"] }, { modifiedFiles: ["a.ts"] });
	assert.deepEqual(overlap.readFiles, []);
	assert.deepEqual(overlap.modifiedFiles, ["a.ts"]);
});

// --- planCompaction ---------------------------------------------------------

test("Pi's cut is used unchanged", () => {
	const plan = planCompaction({ prep: prep(), cfg: cfg() });
	assert.equal(plan.firstKeptEntryId, "e2");
	assert.equal(plan.tokensBefore, 250_000);
});

test("a split task puts the prefix into the digest, in order after the history", () => {
	const prefix: AnyMsg[] = [assistant("early part of the task")];
	const plan = planCompaction({
		prep: prep({ isSplitTurn: true, turnPrefixMessages: prefix }),
		cfg: cfg(),
	});
	assert.equal(plan.firstKeptEntryId, "e2", "Pi's cut, not the turn start");
	assert.equal(plan.summarizedMessages, 3);
	const body = plan.summary;
	assert.ok(body.indexOf("looking") < body.indexOf("early part of the task"), "history precedes the prefix");
	assert.ok(body.includes("early part of the task"), "the prefix is summarised, not kept verbatim");
	assert.equal(plan.details.cliffcompaction.split, true);
});

test("REGRESSION: a split task never moves the cut to the enclosing turn start", () => {
	// Snapping to the turn start keeps the whole user-message span. In an agent
	// run that span is the entire task, so the digest came out empty and the
	// compaction was a no-op that fell back to Pi's LLM summary.
	const everything = "P".repeat(200_000);
	const plan = planCompaction({
		prep: prep({ isSplitTurn: true, turnPrefixMessages: [assistant(everything)] }),
		cfg: cfg(),
	});
	assert.equal(plan.firstKeptEntryId, "e2");
	assert.ok(plan.summary.includes("assistant: PPP"), "the prefix reached the digest");
	assert.notEqual(plan.summary.trim(), "The following is a summary of your previous actions (long observations omitted):");
});

test("the digest drops a long re-runnable result and keeps the call signature", () => {
	const plan = planCompaction({
		prep: prep({ messagesToSummarize: [user("task"), assistant("looking"), result("read", "R".repeat(3000))] }),
		cfg: cfg(),
	});
	assert.ok(!plan.summary.includes("RRRR"));
	assert.equal(plan.stats.dropped, 1);
	assert.equal(plan.details.cliffcompaction.stats.dropped, 1);
});

test("a side-effecting result is excerpted rather than dropped", () => {
	const plan = planCompaction({
		prep: prep({ messagesToSummarize: [assistant("run"), result("bash", "head\n" + "M".repeat(3000) + "\nFAILED")] }),
		cfg: cfg(),
	});
	assert.ok(plan.summary.includes("head"));
	assert.ok(plan.summary.includes("FAILED"), "the tail survives: exit status lives there");
	assert.equal(plan.stats.excerpted, 1);
});

test("the thinking cap reaches the digest", () => {
	const withThinking: AssistantMsg = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "T".repeat(5000) }, { type: "text", text: "step" }],
	};
	const plan = planCompaction({ prep: prep({ messagesToSummarize: [withThinking] }), cfg: cfg({ thinkingMaxChars: 100 }) });
	assert.ok(plan.summary.includes("T".repeat(100) + "..."));
	assert.ok(!plan.summary.includes("T".repeat(101)));
});

test("file lists survive from a previous compaction and gain the current one", () => {
	const plan = planCompaction({
		prep: prep({ fileOps: { read: new Set(["new.ts"]), edited: new Set(["edited.ts"]) } }),
		prevDetails: { readFiles: ["old.ts"], modifiedFiles: [] },
		cfg: cfg(),
	});
	assert.deepEqual(plan.details.readFiles, ["new.ts", "old.ts"].sort());
	assert.deepEqual(plan.details.modifiedFiles, ["edited.ts"]);
	assert.ok(plan.summary.includes("<read-files>\nnew.ts\nold.ts\n</read-files>"));
});

test("nothing to summarise yields a header-only digest", () => {
	const plan = planCompaction({ prep: prep({ messagesToSummarize: [], turnPrefixMessages: [] }), cfg: cfg() });
	assert.equal(plan.summarizedMessages, 0);
	// The caller recognises this and hands back to Pi rather than persisting an
	// empty region.
	assert.ok(plan.summary.startsWith("The following is a summary"));
});
