/**
 * Config precedence and validation.
 *
 * Six sources can supply a value, and the ordering is the kind of thing that is
 * silently wrong until it matters. Each layer is asserted independently.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { DEFAULT_CONFIG } from "./config.ts";
import {
	type ConfigPaths,
	configFilePaths,
	existingConfigFiles,
	loadConfig,
	sanitizeConfig,
	saveUserConfig,
} from "./config-file.ts";

const roots: string[] = [];
function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	roots.push(d);
	return d;
}

after(() => {
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const agentDir = tmp("cliff-cfg-agent-");
const cwd = tmp("cliff-cfg-cwd-");
const paths: ConfigPaths = { agentDir, cwd };
const files = configFilePaths(paths);

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf8");
}

beforeEach(() => {
	for (const p of Object.values(files)) rmSync(p, { force: true });
});

test("with nothing on disk, defaults apply and no source is claimed", () => {
	const { cfg, sources, warnings } = loadConfig(paths);
	assert.equal(cfg.thresholdTokens, DEFAULT_CONFIG.thresholdTokens);
	assert.deepEqual(sources, []);
	assert.deepEqual(warnings, []);
});

test("a cliffcompaction key in Pi's own settings.json is honoured", () => {
	writeJson(files.userSettings, { theme: "dark", cliffcompaction: { thresholdTokens: 111 } });
	const { cfg, sources } = loadConfig(paths);
	assert.equal(cfg.thresholdTokens, 111);
	assert.deepEqual(sources, [files.userSettings]);
});

test("project settings override user settings", () => {
	writeJson(files.userSettings, { cliffcompaction: { thresholdTokens: 111 } });
	writeJson(files.projectSettings, { cliffcompaction: { thresholdTokens: 222 } });
	assert.equal(loadConfig(paths).cfg.thresholdTokens, 222);
});

test("our own config file overrides a settings.json block", () => {
	writeJson(files.userSettings, { cliffcompaction: { thresholdTokens: 111 } });
	writeJson(files.userConfig, { thresholdTokens: 333 });
	assert.equal(loadConfig(paths).cfg.thresholdTokens, 333);
});

test("project config overrides user config", () => {
	writeJson(files.userConfig, { thresholdTokens: 333 });
	writeJson(files.projectConfig, { thresholdTokens: 444 });
	assert.equal(loadConfig(paths).cfg.thresholdTokens, 444);
});

test("flags override every file", () => {
	writeJson(files.projectConfig, { thresholdTokens: 444 });
	assert.equal(loadConfig(paths, { thresholdTokens: 555 }).cfg.thresholdTokens, 555);
});

test("layers merge rather than replace", () => {
	writeJson(files.userConfig, { thresholdTokens: 333 });
	writeJson(files.projectConfig, { thinkingMaxChars: 500 });
	const { cfg } = loadConfig(paths);
	assert.equal(cfg.thresholdTokens, 333, "lower layer survives");
	assert.equal(cfg.thinkingMaxChars, 500);
});

test("a malformed file warns but does not stop the other layers loading", () => {
	writeJson(files.userConfig, { thresholdTokens: 333 });
	writeFileSync(files.projectConfig, "{ not json", "utf8");
	const { cfg, warnings } = loadConfig(paths);
	assert.equal(cfg.thresholdTokens, 333);
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0]?.includes("invalid JSON"));
});

test("saveUserConfig round-trips and creates the directory", () => {
	const fresh: ConfigPaths = { agentDir: tmp("cliff-save-agent-"), cwd: tmp("cliff-save-cwd-") };
	const cfg = { ...DEFAULT_CONFIG, thresholdTokens: 999 };
	saveUserConfig(fresh, cfg);
	const written = JSON.parse(readFileSync(configFilePaths(fresh).userConfig, "utf8")) as { thresholdTokens: number };
	assert.equal(written.thresholdTokens, 999);
	assert.equal(loadConfig(fresh).cfg.thresholdTokens, 999);
});

test("existingConfigFiles lists only what is there", () => {
	writeJson(files.userConfig, { thresholdTokens: 333 });
	assert.deepEqual(existingConfigFiles(paths), [files.userConfig]);
});

// --- sanitisation -----------------------------------------------------------

test("good values pass through", () => {
	const { input, warnings } = sanitizeConfig(
		{
			thresholdTokens: 200_000.7,
			thinkingMode: "drop",
						shadow: false,
			toolPolicy: { dropTools: ["read"], unknown: "keep", alwaysKeepErrors: false },
		},
		"test",
	);
	assert.equal(warnings.length, 0);
	assert.equal(input.thresholdTokens, 200_000, "floored to an integer");
	assert.equal(input.thinkingMode, "drop");
		assert.equal(input.shadow, false);
	assert.deepEqual(input.toolPolicy, { dropTools: ["read"], unknown: "keep", alwaysKeepErrors: false });
});

test("wrong types are dropped with a warning, never passed through", () => {
	const { input, warnings } = sanitizeConfig(
		{ thresholdTokens: "big", shadow: "yes", thinkingMode: "maybe" },
		"test",
	);
	assert.deepEqual(input, {});
	assert.equal(warnings.length, 3);
});

test("negative, non-finite and NaN numbers are rejected", () => {
	const { input, warnings } = sanitizeConfig({ resultMaxChars: -1, thinkingMaxChars: Number.NaN, excerptHead: Infinity }, "test");
	assert.deepEqual(input, {});
	assert.equal(warnings.length, 3);
});

test("zero is a legitimate value", () => {
	// 0 means unlimited for the caps, so it must not be mistaken for falsy.
	const { input } = sanitizeConfig({ thinkingMaxChars: 0, thoughtMaxChars: 0 }, "test");
	assert.equal(input.thinkingMaxChars, 0);
	assert.equal(input.thoughtMaxChars, 0);
});

test("a malformed toolPolicy is dropped whole, not partially applied", () => {
	const { input, warnings } = sanitizeConfig({ toolPolicy: { dropTools: "read" } }, "test");
	assert.equal(input.toolPolicy, undefined);
	assert.equal(warnings.length, 1);
});

test("a non-object config is refused with a warning", () => {
	assert.deepEqual(sanitizeConfig([1, 2], "test").input, {});
	assert.equal(sanitizeConfig([1, 2], "test").warnings.length, 1);
	assert.deepEqual(sanitizeConfig(undefined, "test").input, {});
	assert.equal(sanitizeConfig(undefined, "test").warnings.length, 0, "absent is not an error");
});

test("unknown keys are ignored silently", () => {
	const { input, warnings } = sanitizeConfig({ somethingElse: 1 }, "test");
	assert.deepEqual(input, {});
	assert.deepEqual(warnings, []);
});
