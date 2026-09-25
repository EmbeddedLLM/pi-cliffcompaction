/**
 * Threshold arithmetic.
 *
 * Pi's `reserveTokens` and our `thresholdTokens` are the same number seen from
 * opposite ends, and getting the clamp wrong either makes compaction never fire
 * or makes it fire with no room for a response.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG, effectiveThreshold, resolveConfig, reserveTokensFor } from "./config.ts";

test("a threshold below the window converts to the complement", () => {
	const cfg = resolveConfig({ thresholdTokens: 250_000 });
	assert.equal(reserveTokensFor(cfg, 1_000_000), 750_000);
	assert.equal(effectiveThreshold(1_000_000, 750_000), 250_000);
});

test("a threshold at or beyond the window degrades to the floor, not to zero", () => {
	const cfg = resolveConfig({ thresholdTokens: 1_000_000 });
	// 1M window, 1M threshold: without the clamp this is 0 and the response has
	// nowhere to go.
	assert.equal(reserveTokensFor(cfg, 1_000_000), DEFAULT_CONFIG.reserveFloor);
	assert.equal(effectiveThreshold(1_000_000, DEFAULT_CONFIG.reserveFloor), 983_616);
});

test("the model's maximum output is not treated as a reserve requirement", () => {
	// A 1M-window model with a 256k max output must still allow a 250k threshold.
	const cfg = resolveConfig({ thresholdTokens: 250_000 });
	assert.equal(reserveTokensFor(cfg, 1_000_000), 750_000);
	assert.ok(reserveTokensFor(cfg, 1_000_000) < 1_000_000 - 250_000 + 1);
});

test("a different window yields a different reserve for the same threshold", () => {
	const cfg = resolveConfig({ thresholdTokens: 250_000 });
	assert.equal(reserveTokensFor(cfg, 400_000), 150_000);
	assert.equal(reserveTokensFor(cfg, 250_000), DEFAULT_CONFIG.reserveFloor);
});

test("resolveConfig merges tool policy without losing defaults", () => {
	const cfg = resolveConfig({ toolPolicy: { dropTools: ["bash"] } });
	assert.deepEqual(cfg.toolPolicy.dropTools, ["bash"]);
	assert.deepEqual(cfg.toolPolicy.excerptTools, DEFAULT_CONFIG.toolPolicy.excerptTools);
	assert.equal(cfg.toolPolicy.alwaysKeepErrors, true);
});

test("later inputs win over earlier ones", () => {
	const cfg = resolveConfig({ thinkingMaxChars: 300 }, { thinkingMaxChars: 2000 });
	assert.equal(cfg.thinkingMaxChars, 2000);
});
