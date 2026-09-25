/**
 * Loading our own knobs, and the precedence between their several homes.
 *
 * Lowest to highest:
 *
 *   1. built-in defaults
 *   2. `cliffcompaction` key in the user's Pi settings.json
 *   3. `cliffcompaction` key in the project's Pi settings.json
 *   4. user cliffcompaction.json
 *   5. project cliffcompaction.json
 *   6. CLI flags
 *
 * Sources 2 and 3 exist because Pi preserves unknown top-level keys when it
 * rewrites settings.json, so a user who prefers one config file can have it.
 * The menu writes source 4 only: Pi's own settings write path is not exposed to
 * extensions, and racing it would be the one way to lose a user's configuration.
 *
 * No Pi import here — paths arrive as arguments — so this is unit-testable.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	type CliffConfig,
	type CliffConfigInput,
	type RecentMode,
	type ThinkingMode,
	resolveConfig,
} from "./config.ts";
import type { ToolClass } from "./policy.ts";

export interface ConfigPaths {
	readonly agentDir: string;
	readonly cwd: string;
	readonly configDirName?: string;
}

export interface ResolvedPaths {
	readonly userSettings: string;
	readonly projectSettings: string;
	readonly userConfig: string;
	readonly projectConfig: string;
}

export function configFilePaths(p: ConfigPaths): ResolvedPaths {
	const dir = p.configDirName ?? ".pi";
	return {
		userSettings: join(p.agentDir, "settings.json"),
		projectSettings: join(p.cwd, dir, "settings.json"),
		userConfig: join(p.agentDir, "cliffcompaction.json"),
		projectConfig: join(p.cwd, dir, "cliffcompaction.json"),
	};
}

// --- reading ----------------------------------------------------------------

type JsonResult = { ok: true; value: unknown; existed: boolean } | { ok: false; reason: string };

function readJson(path: string): JsonResult {
	if (!existsSync(path)) return { ok: true, value: undefined, existed: false };
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		return { ok: false, reason: `${path}: ${String(err)}` };
	}
	const trimmed = raw.replace(/^\uFEFF/, "").trim();
	if (trimmed.length === 0) return { ok: true, value: undefined, existed: true };
	try {
		return { ok: true, value: JSON.parse(trimmed), existed: true };
	} catch (err) {
		return { ok: false, reason: `${path}: invalid JSON (${String(err)})` };
	}
}

// --- validation -------------------------------------------------------------

const NUMBER_KEYS = [
	"thresholdTokens",
	"reserveFloor",
	"keepRecentTokens",
	"maxTurnOvershoot",
	"keepRecentTurns",
	"resultMaxChars",
	"cmdMaxChars",
	"thinkingMaxChars",
	"thoughtMaxChars",
	"humanMaxChars",
	"excerptHead",
	"excerptTail",
] as const;

const BOOL_KEYS = ["honorManualInstructions", "shadow"] as const;
const RECENT_MODES: readonly RecentMode[] = ["tokens-snapped", "tokens", "turns"];
const THINKING_MODES: readonly ThinkingMode[] = ["keep", "drop"];
const TOOL_CLASSES: readonly ToolClass[] = ["drop", "excerpt", "keep"];

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Coerce an untrusted object into a partial config, dropping anything malformed.
 *
 * A bad value must never reach the serializer as a string, NaN, or a negative
 * cap, so each key is type-checked rather than trusted.
 */
export function sanitizeConfig(raw: unknown, where: string): { input: CliffConfigInput; warnings: string[] } {
	const warnings: string[] = [];
	const input: Record<string, unknown> = {};
	if (raw === undefined) return { input: input as CliffConfigInput, warnings };
	if (!isRecord(raw)) {
		warnings.push(`${where}: expected a JSON object, ignoring`);
		return { input: input as CliffConfigInput, warnings };
	}

	for (const key of NUMBER_KEYS) {
		const v = raw[key];
		if (v === undefined) continue;
		if (typeof v === "number" && Number.isFinite(v) && v >= 0) input[key] = Math.floor(v);
		else warnings.push(`${where}: ${key} must be a non-negative finite number, ignoring`);
	}
	for (const key of BOOL_KEYS) {
		const v = raw[key];
		if (v === undefined) continue;
		if (typeof v === "boolean") input[key] = v;
		else warnings.push(`${where}: ${key} must be a boolean, ignoring`);
	}
	if (raw.recentMode !== undefined) {
		if (RECENT_MODES.includes(raw.recentMode as RecentMode)) input.recentMode = raw.recentMode;
		else warnings.push(`${where}: recentMode must be one of ${RECENT_MODES.join(", ")}, ignoring`);
	}
	if (raw.thinkingMode !== undefined) {
		if (THINKING_MODES.includes(raw.thinkingMode as ThinkingMode)) input.thinkingMode = raw.thinkingMode;
		else warnings.push(`${where}: thinkingMode must be one of ${THINKING_MODES.join(", ")}, ignoring`);
	}
	if (raw.toolPolicy !== undefined) {
		if (!isRecord(raw.toolPolicy)) {
			warnings.push(`${where}: toolPolicy must be an object, ignoring`);
		} else {
			const tp: Record<string, unknown> = {};
			for (const key of ["dropTools", "excerptTools"] as const) {
				const v = raw.toolPolicy[key];
				if (v === undefined) continue;
				if (Array.isArray(v) && v.every((x) => typeof x === "string")) tp[key] = v as string[];
				else warnings.push(`${where}: toolPolicy.${key} must be an array of strings, ignoring`);
			}
			const unknown = raw.toolPolicy.unknown;
			if (unknown !== undefined) {
				if (TOOL_CLASSES.includes(unknown as ToolClass)) tp.unknown = unknown;
				else warnings.push(`${where}: toolPolicy.unknown must be ${TOOL_CLASSES.join("/")}, ignoring`);
			}
			const keepErrors = raw.toolPolicy.alwaysKeepErrors;
			if (keepErrors !== undefined) {
				if (typeof keepErrors === "boolean") tp.alwaysKeepErrors = keepErrors;
				else warnings.push(`${where}: toolPolicy.alwaysKeepErrors must be a boolean, ignoring`);
			}
			if (Object.keys(tp).length > 0) input.toolPolicy = tp;
		}
	}
	return { input: input as CliffConfigInput, warnings };
}

// --- loading ----------------------------------------------------------------

export interface LoadedConfig {
	readonly cfg: CliffConfig;
	readonly warnings: string[];
	/** Files that contributed a value, lowest precedence first. */
	readonly sources: string[];
}

function nestedCliffBlock(value: unknown): unknown {
	if (!isRecord(value)) return undefined;
	return value.cliffcompaction;
}

export function loadConfig(paths: ConfigPaths, flags?: CliffConfigInput): LoadedConfig {
	const files = configFilePaths(paths);
	const warnings: string[] = [];
	const inputs: CliffConfigInput[] = [];
	const sources: string[] = [];

	const readInto = (path: string, pick: (v: unknown) => unknown, label: string): void => {
		const r = readJson(path);
		if (!r.ok) {
			warnings.push(r.reason);
			return;
		}
		const raw = pick(r.value);
		if (raw === undefined) return;
		const { input, warnings: w } = sanitizeConfig(raw, label);
		warnings.push(...w);
		if (Object.keys(input).length > 0) {
			inputs.push(input);
			sources.push(path);
		}
	};

	readInto(files.userSettings, nestedCliffBlock, "user settings");
	readInto(files.projectSettings, nestedCliffBlock, "project settings");
	readInto(files.userConfig, (v) => v, "user config");
	readInto(files.projectConfig, (v) => v, "project config");
	if (flags) inputs.push(flags);

	return { cfg: resolveConfig(...inputs), warnings, sources };
}

/** The menu writes here: never Pi's settings.json, whose writer we cannot share. */
export function saveUserConfig(paths: ConfigPaths, cfg: CliffConfig): void {
	const path = configFilePaths(paths).userConfig;
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** Which config files already exist, for the status panel. */
export function existingConfigFiles(paths: ConfigPaths): string[] {
	const files = configFilePaths(paths);
	return Object.values(files).filter((p) => existsSync(p));
}
