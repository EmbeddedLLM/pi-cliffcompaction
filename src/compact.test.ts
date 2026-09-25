/**
 * Cut planning and the adapter's decision rules.
 *
 * The snap logic is the part most likely to be subtly wrong, so it is tested as
 * a pure function: no Pi runtime, no session files.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type CutCandidate,
	type Preparation,
	decideSnap,
	enclosingTurnStartIndex,
	fileOpsToLists,
	finalizeFileLists,
	planCompaction,
	readFileLists,
	shouldDeferToPi,
} from "./compact.ts";
import { type CliffConfigInput, resolveConfig } from "./config.ts";
import type { AssistantMsg, AnyMsg, ToolResultMsg, UserMsg } from "./types.ts";

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

/** `u` = turn start, `a` = continuation. */
const chain = (spec: string): CutCandidate[] =>
	spec.split(" ").map((tok, i) => ({
		id: `e${i}`,
		startsTurn: tok.startsWith("u"),
		...(tok === "c" ? { isCompactionBoundary: true } : {}),
	}));

// --- turn snapping ----------------------------------------------------------

test("walks back to the enclosing turn start", () => {
	// u0 a1 a2 a3 : from a3, the enclosing turn start is u0
	const c = chain("u a a a");
	assert.equal(enclosingTurnStartIndex(c, 3), 0);
	assert.equal(enclosingTurnStartIndex(c, 0), 0);
});

test("stops at the nearest turn start, not the first", () => {
	const c = chain("u a u a a");
	assert.equal(enclosingTurnStartIndex(c, 4), 2);
	assert.equal(enclosingTurnStartIndex(c, 3), 2);
});

test("never snaps to or past a prior compaction boundary", () => {
	// c0 u1 a2: from a2 we would want u1, but the compaction is before it, and
	// we must not reach back into the compacted region at all.
	const c = chain("c u a");
	assert.equal(enclosingTurnStartIndex(c, 2), 1, "u1 is still reachable: it is after the boundary");
	const c2 = chain("u a c a");
	assert.equal(enclosingTurnStartIndex(c2, 3), -1, "crossing the boundary is refused");
});

test("returns -1 when there is no turn start at all", () => {
	assert.equal(enclosingTurnStartIndex(chain("a a"), 1), -1);
});

// --- decideSnap -------------------------------------------------------------

test("a non-split cut snaps to itself, changing nothing", () => {
	const d = decideSnap({ isSplitTurn: false, overshootTokens: 0, turnStartId: "e0", cfg: cfg() });
	assert.equal(d.snap, true);
	assert.equal(d.reason, "not-split");
});

test("a split cut snaps when the whole turn fits the overshoot allowance", () => {
	const d = decideSnap({ isSplitTurn: true, overshootTokens: 5_000, turnStartId: "e0", cfg: cfg() });
	assert.equal(d.snap, true);
	assert.equal(d.reason, "snapped");
	assert.equal(d.overshootTokens, 5_000);
});

test("a split cut falls back to Pi when the whole turn is too large", () => {
	const d = decideSnap({ isSplitTurn: true, overshootTokens: 50_000, turnStartId: "e0", cfg: cfg() });
	assert.equal(d.snap, false);
	assert.equal(d.reason, "overshoot-exceeded");
});

test("the overshoot allowance is configurable", () => {
	const strict = cfg({ maxTurnOvershoot: 1_000 });
	assert.equal(decideSnap({ isSplitTurn: true, overshootTokens: 5_000, turnStartId: "e0", cfg: strict }).snap, false);
	const loose = cfg({ maxTurnOvershoot: 100_000 });
	assert.equal(decideSnap({ isSplitTurn: true, overshootTokens: 50_000, turnStartId: "e0", cfg: loose }).snap, true);
});

test("a split with no reachable turn start falls back rather than guessing", () => {
	const d = decideSnap({ isSplitTurn: true, overshootTokens: 10, turnStartId: null, cfg: cfg() });
	assert.equal(d.snap, false);
	assert.equal(d.reason, "no-turn-start");
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

// --- file list carrying -----------------------------------------------------

test("file lists are read from Pi's own details shape", () => {
	assert.deepEqual(readFileLists({ readFiles: ["a"], modifiedFiles: ["b"] }), {
		readFiles: ["a"],
		modifiedFiles: ["b"],
	});
});

test("Pi's FileOperations Sets are normalised", () => {
	const ops = { read: new Set(["a.ts", "b.ts"]), written: new Set(["c.ts"]), edited: new Set(["b.ts"]) };
	const lists = fileOpsToLists(ops);
	assert.deepEqual(finalizeFileLists(lists), {
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

test("a foreign or malformed details shape yields empty lists, never a throw", () => {
	for (const d of [null, undefined, 42, "x", {}, { readFiles: "a" }, { readFiles: [1, 2] }]) {
		assert.deepEqual(readFileLists(d), { readFiles: [], modifiedFiles: [] });
	}
});

test("carried lists merge, dedupe, sort and exclude modified from read", () => {
	const merged = finalizeFileLists(
		{ readFiles: ["b.ts", "a.ts"], modifiedFiles: ["x.ts"] },
		{ readFiles: ["b.ts", "c.ts"] },
	);
	assert.deepEqual(merged.readFiles, ["a.ts", "b.ts", "c.ts"]);
	assert.deepEqual(merged.modifiedFiles, ["x.ts"], "a partial input does not drop the other list");
	// A file modified in an earlier compaction leaves the read list.
	const overlap = finalizeFileLists({ readFiles: ["a.ts"] }, { modifiedFiles: ["a.ts"] });
	assert.deepEqual(overlap.readFiles, []);
	assert.deepEqual(overlap.modifiedFiles, ["a.ts"]);
});

// --- planCompaction ---------------------------------------------------------

const prep = (over: Partial<Preparation> = {}): Preparation => ({
	firstKeptEntryId: "e2",
	messagesToSummarize: [user("task"), result("read", "R".repeat(3000))],
	turnPrefixMessages: [],
	isSplitTurn: false,
	tokensBefore: 250_000,
	...over,
});

const estimate = (m: AnyMsg): number => {
	const c = (m as { content?: unknown }).content;
	if (typeof c === "string") return Math.ceil(c.length / 4);
	if (Array.isArray(c)) {
		let n = 0;
		for (const b of c) {
			const t = (b as { text?: unknown }).text;
			if (typeof t === "string") n += t.length;
		}
		return Math.ceil(n / 4);
	}
	return 100;
};

test("a split compaction keeps the whole turn and does not summarise the prefix", () => {
	const prefix: AnyMsg[] = [assistant("early part of the turn")];
	const plan = planCompaction({
		prep: prep({ isSplitTurn: true, turnPrefixMessages: prefix }),
		cutCandidates: chain("u a a a"),
		cfg: cfg(),
		estimate,
	});
	assert.equal(plan.snap.snap, true);
	assert.equal(plan.firstKeptEntryId, "e0", "cut moved back to the turn start");
	assert.equal(plan.summarizedMessages, 2, "prefix was not added to the digest");
	assert.ok(!plan.summary.includes("early part of the turn"), "prefix is kept verbatim, not summarised");
});

test("a fallback split summarises the prefix and keeps Pi's cut", () => {
	const big = "P".repeat(400_000);
	const plan = planCompaction({
		prep: prep({ isSplitTurn: true, turnPrefixMessages: [assistant(big)] }),
		cutCandidates: chain("u a a a"),
		cfg: cfg(),
		estimate,
	});
	assert.equal(plan.snap.snap, false);
	assert.equal(plan.snap.reason, "overshoot-exceeded");
	assert.equal(plan.firstKeptEntryId, "e2", "Pi's cut honoured");
	assert.equal(plan.summarizedMessages, 3, "prefix folded into the digest");
	assert.ok(plan.summary.includes("P".repeat(2000)), "prefix text reached the digest, capped");
});

test("a non-split compaction leaves the cut untouched", () => {
	const plan = planCompaction({
		prep: prep(),
		// Pi's invariant: when not split, firstKeptEntryId is itself a turn start.
		cutCandidates: chain("u a u"),
		cfg: cfg(),
		estimate,
	});
	assert.equal(plan.snap.snap, true);
	assert.equal(plan.snap.reason, "not-split");
	assert.equal(plan.firstKeptEntryId, "e2");
	assert.equal(plan.summarizedMessages, 2);
});

test("the digest drops the long read result and keeps the signature path", () => {
	const plan = planCompaction({
		prep: prep({ messagesToSummarize: [user("task"), result("read", "R".repeat(3000))] }),
		cutCandidates: chain("u a a"),
		cfg: cfg(),
		estimate,
	});
	assert.ok(!plan.summary.includes("RRRR"));
	assert.equal(plan.stats.dropped, 1);
	assert.equal(plan.details.cliffcompaction.stats.dropped, 1);
});

test("file lists survive from a previous compaction and gain the current one", () => {
	const plan = planCompaction({
		prep: prep({ fileOps: { read: new Set(["new.ts"]), edited: new Set(["edited.ts"]) } }),
		cutCandidates: chain("u a a"),
		cfg: cfg(),
		prevDetails: { readFiles: ["old.ts"], modifiedFiles: [] },
		estimate,
	});
	assert.deepEqual(plan.details.readFiles, ["new.ts", "old.ts"].sort());
	assert.deepEqual(plan.details.modifiedFiles, ["edited.ts"]);
	assert.ok(plan.summary.includes("<read-files>\nnew.ts\nold.ts\n</read-files>"));
});

test("tokensBefore is passed through unchanged", () => {
	const plan = planCompaction({ prep: prep({ tokensBefore: 123 }), cutCandidates: chain("u a a"), cfg: cfg(), estimate });
	assert.equal(plan.tokensBefore, 123);
});
