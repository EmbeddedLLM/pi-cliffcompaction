/**
 * Pi settings integration: the safety properties of the write, and the
 * threshold arithmetic as it lands in the file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { type CliffConfigInput, resolveConfig } from "./config.ts";
import {
	compactionEnabled,
	modelKey,
	readSettings,
	resolveKeepRecentTokens,
	resolveReserveTokens,
	serializeSettings,
	withAppliedThreshold,
	withoutAppliedThreshold,
	writeSettingsAtomic,
} from "./settings.ts";

const dirs: string[] = [];
function tmpFile(name = "settings.json"): string {
	const d = mkdtempSync(join(tmpdir(), "cliff-settings-"));
	dirs.push(d);
	return join(d, name);
}

after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const cfg = (over: CliffConfigInput = {}) => resolveConfig(over);

// --- reading ----------------------------------------------------------------

test("a missing file is success with empty settings, not an error", () => {
	const r = readSettings(tmpFile());
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.deepEqual(r.settings, {});
		assert.equal(r.existed, false);
	}
});

test("a malformed file is reported as failure so the write can be refused", () => {
	const p = tmpFile();
	writeFileSync(p, "{ this is not json");
	const r = readSettings(p);
	assert.equal(r.ok, false);
});

test("a non-object root is rejected", () => {
	const p = tmpFile();
	writeFileSync(p, "[1,2,3]");
	assert.equal(readSettings(p).ok, false);
});

test("an empty file reads as empty settings", () => {
	const p = tmpFile();
	writeFileSync(p, "\n  \n");
	const r = readSettings(p);
	assert.equal(r.ok, true);
	if (r.ok) assert.deepEqual(r.settings, {});
});

// --- applying the threshold -------------------------------------------------

test("applying the threshold writes both values Pi owns", () => {
	const out = withAppliedThreshold({}, "prov/model", 1_000_000, cfg({ thresholdTokens: 250_000 }));
	assert.equal(out.compaction?.modelOverrides?.["prov/model"]?.reserveTokens, 750_000);
	// keepRecentTokens is Pi's knob too; writing only the reserve would let Pi's
	// 20k default silently win for the kept window.
	assert.equal(out.compaction?.modelOverrides?.["prov/model"]?.keepRecentTokens, 40_000);
});

test("applying the threshold preserves every foreign key", () => {
	const before = {
		theme: "dark",
		defaultModel: "x",
		compaction: { reserveTokens: 111, modelOverrides: { "other/m": { reserveTokens: 222 } } },
		cliffcompaction: { thresholdTokens: 1 },
	};
	const out = withAppliedThreshold(before, "prov/model", 400_000, cfg({ thresholdTokens: 250_000 }));
	assert.equal(out.theme, "dark");
	assert.deepEqual(out.cliffcompaction, { thresholdTokens: 1 });
	// Untouched models and the ordinary setting survive.
	assert.equal(out.compaction?.reserveTokens, 111);
	assert.equal(out.compaction?.modelOverrides?.["other/m"]?.reserveTokens, 222);
	assert.equal(out.compaction?.modelOverrides?.["prov/model"]?.reserveTokens, 150_000);
});

test("the input object is not mutated", () => {
	const before = { compaction: { reserveTokens: 111 } };
	withAppliedThreshold(before, "prov/model", 400_000, cfg());
	assert.deepEqual(before, { compaction: { reserveTokens: 111 } });
});

test("compaction is left enabled unless it was explicitly off", () => {
	assert.equal(withAppliedThreshold({}, "a/b", 1000, cfg()).compaction?.enabled, true);
	const off = withAppliedThreshold({ compaction: { enabled: false } }, "a/b", 1000, cfg());
	assert.equal(off.compaction?.enabled, false, "we do not override an explicit choice");
	assert.equal(compactionEnabled(off), false);
});

// --- resolving --------------------------------------------------------------

test("reserveTokens resolves model override, then ordinary, then builtin", () => {
	const s = { compaction: { reserveTokens: 5, modelOverrides: { "a/b": { reserveTokens: 7 } } } };
	assert.equal(resolveReserveTokens(s, "a/b"), 7);
	assert.equal(resolveReserveTokens(s, "c/d"), 5);
	assert.equal(resolveReserveTokens({}, "c/d", 9), 9);
});

test("keepRecentTokens falls back independently of reserveTokens", () => {
	// Pi resolves the two separately: an override may set only one of them.
	const s = { compaction: { reserveTokens: 5, keepRecentTokens: 6, modelOverrides: { "a/b": { reserveTokens: 7 } } } };
	assert.equal(resolveReserveTokens(s, "a/b"), 7);
	assert.equal(resolveKeepRecentTokens(s, "a/b"), 6, "falls through to the ordinary setting");
});

test("modelKey is the exact provider/modelId pair", () => {
	assert.equal(modelKey("anthropic", "claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
	assert.equal(modelKey("zai-org", "GLM-5.2"), "zai-org/GLM-5.2");
	assert.equal(modelKey(undefined, "m"), null);
	assert.equal(modelKey("p", undefined), null);
});

// --- writing ----------------------------------------------------------------

test("the write round-trips and matches Pi's own formatting", () => {
	const p = tmpFile();
	writeSettingsAtomic(p, { theme: "dark", compaction: { reserveTokens: 1 } });
	const raw = readFileSync(p, "utf8");
	assert.equal(raw, JSON.stringify({ theme: "dark", compaction: { reserveTokens: 1 } }, null, 2));
	const back = readSettings(p);
	assert.equal(back.ok, true);
	if (back.ok) assert.equal(back.settings.theme, "dark");
});

test("the write creates the parent directory", () => {
	const p = tmpFile(join("nested", "deeper", "settings.json"));
	writeSettingsAtomic(p, { a: 1 });
	assert.equal(readSettings(p).ok, true);
});

test("serializeSettings produces newline-free, 2-space JSON", () => {
	assert.equal(serializeSettings({ a: [1, 2] }), '{\n  "a": [\n    1,\n    2\n  ]\n}');
});

// --- deactivation -----------------------------------------------------------

test("deactivating removes the override and leaves nothing of ours behind", () => {
	const applied = withAppliedThreshold({ theme: "dark" }, "prov/model", 1_000_000, cfg());
	const back = withoutAppliedThreshold(applied, "prov/model");
	// Uninstalling does not undo the threshold, so this is the only clean revert.
	assert.equal(back.compaction, undefined, "no compaction block left behind");
	assert.deepEqual(back, { theme: "dark" });
});

test("deactivating leaves other models and Pi's own settings alone", () => {
	const before = {
		compaction: {
			reserveTokens: 111,
			modelOverrides: { "a/b": { reserveTokens: 7 }, "c/d": { reserveTokens: 9 } },
		},
	};
	const after = withoutAppliedThreshold(before, "a/b");
	assert.equal(after.compaction?.reserveTokens, 111, "the ordinary setting is untouched");
	assert.equal(after.compaction?.modelOverrides?.["a/b"], undefined);
	assert.equal(after.compaction?.modelOverrides?.["c/d"]?.reserveTokens, 9);
});

test("deactivating drops an enabled:true we added, since that is the default", () => {
	const applied = withAppliedThreshold({}, "a/b", 1000, cfg());
	assert.equal(applied.compaction?.enabled, true, "we set it");
	assert.deepEqual(withoutAppliedThreshold(applied, "a/b"), {}, "and clear it again");
});

test("deactivating preserves an explicit enabled:false", () => {
	const s = { compaction: { enabled: false, modelOverrides: { "a/b": { reserveTokens: 1 } } } };
	const after = withoutAppliedThreshold(s, "a/b");
	assert.equal(after.compaction?.enabled, false, "the user's choice is not ours to remove");
});

test("deactivating something never applied is a no-op", () => {
	const s = { theme: "dark", compaction: { reserveTokens: 111 } };
	assert.deepEqual(withoutAppliedThreshold(s, "nothing/here"), s);
});
