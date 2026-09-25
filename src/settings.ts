/**
 * Pi's `settings.json`: reading it for reporting, and applying the threshold.
 *
 * Pi owns the trigger, and the only lever is `compaction.reserveTokens` — our
 * `thresholdTokens` is its complement. There is no supported API for this:
 * `SettingsManager`'s public surface has no compaction setter, and `/settings`
 * does not expose `compaction.*` at all. So the write is a plain atomic
 * read-modify-write of the JSON file.
 *
 * Two safety properties matter more than the write itself:
 *
 *  - We must never clobber a file we could not parse. `readSettings` reports
 *    failure rather than returning `{}`, so a malformed settings.json stops the
 *    write instead of silently discarding the user's configuration.
 *  - We must preserve every key we do not own. Pi itself merges into the parsed
 *    file rather than rewriting a known-field schema, so round-tripping is safe
 *    and foreign keys survive.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type CliffConfig, reserveTokensFor } from "./config.ts";

export interface CompactionModelOverride {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

export interface PiCompactionSettings {
	enabled?: boolean;
	reserveTokens?: number;
	keepRecentTokens?: number;
	modelOverrides?: Record<string, CompactionModelOverride>;
}

export interface PiSettings {
	compaction?: PiCompactionSettings;
	[key: string]: unknown;
}

export type ReadResult =
	| { ok: true; settings: PiSettings; existed: boolean }
	| { ok: false; reason: string };

/** `missing` is success with an empty object; `unparseable` is failure. */
export function readSettings(path: string): ReadResult {
	if (!existsSync(path)) return { ok: true, settings: {}, existed: false };
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		return { ok: false, reason: `cannot read ${path}: ${String(err)}` };
	}
	const trimmed = raw.replace(/^\uFEFF/, "").trim();
	if (trimmed.length === 0) return { ok: true, settings: {}, existed: true };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, reason: `${path} is not a JSON object` };
		}
		return { ok: true, settings: parsed as PiSettings, existed: true };
	} catch (err) {
		return { ok: false, reason: `${path} is not valid JSON: ${String(err)}` };
	}
}

/** Matches Pi's own formatting (`JSON.stringify(obj, null, 2)`) so the file does
 *  not churn between our writes and Pi's. */
export function serializeSettings(settings: PiSettings): string {
	return JSON.stringify(settings, null, 2);
}

export function writeSettingsAtomic(path: string, settings: PiSettings): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.cliff-tmp`;
	writeFileSync(tmp, serializeSettings(settings), "utf8");
	renameSync(tmp, path);
}

/** The key Pi resolves `modelOverrides` against: exact, case-sensitive. */
export function modelKey(provider: string | undefined, modelId: string | undefined): string | null {
	if (!provider || !modelId) return null;
	return `${provider}/${modelId}`;
}

/**
 * Return a copy with the threshold applied for one model.
 *
 * Both values belong to Pi: `reserveTokens` *is* the trigger, and
 * `keepRecentTokens` *is* the kept window. Applying only one of them would let
 * Pi's default silently win for the other.
 */
export function withAppliedThreshold(
	settings: PiSettings,
	key: string,
	contextWindow: number,
	cfg: CliffConfig,
): PiSettings {
	const compaction: PiCompactionSettings = { ...(settings.compaction ?? {}) };
	const overrides: Record<string, CompactionModelOverride> = { ...(compaction.modelOverrides ?? {}) };
	overrides[key] = {
		...overrides[key],
		reserveTokens: reserveTokensFor(cfg, contextWindow),
		keepRecentTokens: cfg.keepRecentTokens,
	};
	compaction.modelOverrides = overrides;
	if (compaction.enabled === undefined) compaction.enabled = true;
	return { ...settings, compaction };
}

/** Pi's resolution order: model override, then ordinary setting, then built-in. */
export function resolveReserveTokens(
	settings: PiSettings,
	key: string | null,
	builtin = 16_384,
): number {
	const c = settings.compaction;
	const override = key ? c?.modelOverrides?.[key]?.reserveTokens : undefined;
	return override ?? c?.reserveTokens ?? builtin;
}

export function resolveKeepRecentTokens(
	settings: PiSettings,
	key: string | null,
	builtin = 20_000,
): number {
	const c = settings.compaction;
	const override = key ? c?.modelOverrides?.[key]?.keepRecentTokens : undefined;
	return override ?? c?.keepRecentTokens ?? builtin;
}

/** Whether compaction is on at all. `undefined` means Pi's default, which is on. */
export function compactionEnabled(settings: PiSettings): boolean {
	return settings.compaction?.enabled !== false;
}
