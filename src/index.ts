/**
 * Pi extension entry point.
 *
 * Division of labour: Pi decides *when* to compact (its trigger, its cut), and
 * this decides *what the summary is*. The single integration point for that is
 * `session_before_compact`, which fires for all three compaction reasons —
 * threshold, manual `/compact`, and overflow recovery.
 *
 * Fail-open is the contract. Anything that goes wrong here returns `undefined`,
 * and Pi falls back to its own LLM summariser. A compaction must never fail
 * because of this extension.
 */

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	type Preparation,
	planCompaction,
	shouldDeferToPi,
} from "./compact.ts";
import type { CliffConfig, CliffConfigInput } from "./config.ts";
import { type ConfigPaths, configFilePaths, loadConfig, saveUserConfig } from "./config-file.ts";
import { SUMMARY_HEADER } from "./serialize.ts";
import {
	effectiveThresholdLabel,
	modelKey,
	readSettings,
	resolveKeepRecentTokens,
	resolveReserveTokens,
	withAppliedThreshold,
	writeSettingsAtomic,
} from "./settings.ts";

/** Structural view of a session entry; only these fields are read. */
interface SessionEntryLike {
	readonly type?: string;
	readonly id?: string;
	readonly details?: unknown;
}

interface LastRun {
	readonly reason: string;
	readonly before: number;
	readonly originalChars: number;
	readonly droppedChars: number;
	readonly excerptedChars: number;
	readonly split: boolean;
	readonly shadow: boolean;
}

interface State {
	cfg: CliffConfig;
	readonly paths: ConfigPaths;
	readonly warnings: string[];
	readonly sources: string[];
	last: LastRun | null;
	compactions: number;
}

let state: State | null = null;

/**
 * The most recent compaction on this branch, if there is one.
 *
 * Its presence matters as much as its `details`: "no previous compaction" means
 * this is the origin and the task should be captured, while "a previous compaction
 * carrying no task" means the chain broke and no pin can be trusted.
 */
function previousCompaction(entries: readonly SessionEntryLike[]): { details?: unknown } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type === "compaction") return { details: e.details };
	}
	return undefined;
}

// --- status -----------------------------------------------------------------

function statusText(ctx: ExtensionContext): string {
	const s = state;
	if (!s) return "CliffCompaction: not initialised";
	const files = configFilePaths(s.paths);
	const r = readSettings(files.userSettings);
	const model = ctx.model;
	const lines: string[] = [s.cfg.shadow ? "mode    shadow — computes, modifies nothing" : "mode    active"];

	if (model) {
		const key = modelKey(model.provider, model.id) ?? "(unknown model)";
		if (!r.ok) {
			lines.push(`config  ${s.cfg.thresholdTokens} configured, but ${r.reason}`);
		} else {
			const reserve = resolveReserveTokens(r.settings, modelKey(model.provider, model.id), s.cfg.reserveFloor);
			const keep = resolveKeepRecentTokens(r.settings, modelKey(model.provider, model.id), s.cfg.keepRecentTokens);
			const label = effectiveThresholdLabel(model.contextWindow, reserve);
			const applied = reserve === Math.max(s.cfg.reserveFloor, model.contextWindow - s.cfg.thresholdTokens);
			lines.push(`model   ${key}  (window ${Math.round(model.contextWindow / 1000)}k)`);
			lines.push(
				`config  ${applied ? "in effect" : "NOT applied"}: fires at ~${label}, keeps ~${Math.round(keep / 1000)}k`,
			);
			lines.push(`        wanted: ${s.cfg.thresholdTokens} → reserveTokens ${Math.max(s.cfg.reserveFloor, model.contextWindow - s.cfg.thresholdTokens)}`);
		}
	} else {
		lines.push(`config  threshold ${s.cfg.thresholdTokens} (no active model)`);
	}

	lines.push(
		`policy  results>${s.cfg.resultMaxChars} dropped/excerpted · thinking≤${s.cfg.thinkingMaxChars || "∞"} · text≤${s.cfg.thoughtMaxChars || "∞"}`,
		`sources ${s.sources.length > 0 ? s.sources.join(", ") : "defaults only"}`,
		`handled ${s.compactions} compaction(s) this session`,
	);
	if (s.last) {
		const pct = s.last.originalChars > 0 ? Math.round(((s.last.droppedChars + s.last.excerptedChars) / s.last.originalChars) * 100) : 0;
		lines.push(
			`last    ${s.last.reason} · ${s.last.split ? "split task" : "whole task"} · dropped ${s.last.droppedChars} + excerpted ${s.last.excerptedChars} chars (~${pct}% of the region)${s.last.shadow ? " [shadow]" : ""}`,
		);
	}
	for (const w of s.warnings) lines.push(`warning ${w}`);
	return lines.join("\n");
}

function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const s = state;
	if (!s) return;
	if (s.cfg.shadow) {
		ctx.ui.setStatus("cliffcompaction", "cliff shadow");
		return;
	}
	const last = s.last;
	if (!last) {
		ctx.ui.setStatus("cliffcompaction", "cliff");
		return;
	}
	const pct = last.originalChars > 0 ? Math.round(((last.droppedChars + last.excerptedChars) / last.originalChars) * 100) : 0;
	ctx.ui.setStatus("cliffcompaction", `cliff −${pct}%`);
}

// --- threshold application --------------------------------------------------

async function applyThreshold(ctx: ExtensionCommandContext): Promise<string> {
	const s = state;
	if (!s) return "not initialised";
	const model = ctx.model;
	if (!model) return "cannot determine the active model; nothing written";
	const key = modelKey(model.provider, model.id);
	if (!key) return "cannot determine the active model key; nothing written";

	const files = configFilePaths(s.paths);
	const r = readSettings(files.userSettings);
	// Refusing to write an unparseable file is the point: overwriting it would
	// discard a configuration we failed to understand.
	if (!r.ok) return `refusing to write: ${r.reason}`;

	const next = withAppliedThreshold(r.settings, key, model.contextWindow, s.cfg);
	try {
		writeSettingsAtomic(files.userSettings, next);
	} catch (err) {
		return `write failed: ${String(err)}`;
	}
	const reserve = resolveReserveTokens(next, key, s.cfg.reserveFloor);
	const keep = resolveKeepRecentTokens(next, key, s.cfg.keepRecentTokens);
	return `applied for ${key}: fires at ~${effectiveThresholdLabel(model.contextWindow, reserve)}, keeps ~${Math.round(keep / 1000)}k`;
}

// --- command ----------------------------------------------------------------

function parsePositiveInt(v: string | undefined): number | null {
	if (v === undefined) return null;
	const n = Number(v.trim());
	if (!Number.isFinite(n) || n < 0) return null;
	return Math.floor(n);
}

async function menu(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const s = state;
		if (!s) {
			ctx.ui.notify("CliffCompaction: no session state yet", "warning");
			return;
		}
		const choice = await ctx.ui.select("CliffCompaction", [
			"Status",
			"Apply threshold to Pi settings",
			"Set threshold (tokens)…",
			"Set thinking cap (chars)…",
			"Set result cap (chars)…",
			"Toggle shadow mode",
			"Restore defaults",
			"Done",
		]);
		if (choice === undefined || choice === "Done") return;

		switch (choice) {
			case "Status":
				ctx.ui.notify(statusText(ctx), "info");
				continue;
			case "Apply threshold to Pi settings": {
				const msg = await applyThreshold(ctx);
				ctx.ui.notify(msg, msg.startsWith("applied") ? "info" : "warning");
				// Pi reads settings from disk on reload, and that is the only way we
				// can make the threshold take effect. State must not be reused after:
				// reload replaces the extension runtime.
				if (msg.startsWith("applied")) await ctx.reload();
				return;
			}
			case "Set threshold (tokens)…": {
				const n = parsePositiveInt(await ctx.ui.input("Compaction threshold B (tokens)", String(s.cfg.thresholdTokens)));
				if (n === null) {
					ctx.ui.notify("not a number, unchanged", "warning");
					continue;
				}
				s.cfg = { ...s.cfg, thresholdTokens: n };
				saveUserConfig(s.paths, s.cfg);
				ctx.ui.notify(`thresholdTokens = ${n}. Use "Apply threshold" to make Pi fire there.`, "info");
				continue;
			}
			case "Set thinking cap (chars)…": {
				const n = parsePositiveInt(await ctx.ui.input("Thinking cap per message (0 = unlimited)", String(s.cfg.thinkingMaxChars)));
				if (n === null) {
					ctx.ui.notify("not a number, unchanged", "warning");
					continue;
				}
				s.cfg = { ...s.cfg, thinkingMaxChars: n };
				saveUserConfig(s.paths, s.cfg);
				ctx.ui.notify(`thinkingMaxChars = ${n}`, "info");
				continue;
			}
			case "Set result cap (chars)…": {
				const n = parsePositiveInt(await ctx.ui.input("Tool-result cap (chars)", String(s.cfg.resultMaxChars)));
				if (n === null) {
					ctx.ui.notify("not a number, unchanged", "warning");
					continue;
				}
				s.cfg = { ...s.cfg, resultMaxChars: n };
				saveUserConfig(s.paths, s.cfg);
				ctx.ui.notify(`resultMaxChars = ${n}`, "info");
				continue;
			}
			case "Toggle shadow mode": {
				s.cfg = { ...s.cfg, shadow: !s.cfg.shadow };
				saveUserConfig(s.paths, s.cfg);
				updateStatus(ctx);
				ctx.ui.notify(s.cfg.shadow ? "shadow mode on: nothing will be modified" : "shadow mode off: compactions now use the mechanical digest", s.cfg.shadow ? "info" : "warning");
				continue;
			}
			case "Restore defaults": {
				const ok = await ctx.ui.confirm("Restore defaults", "Overwrite the user config with the shipped defaults?");
				if (!ok) continue;
				s.cfg = loadConfig(s.paths).cfg;
				saveUserConfig(s.paths, s.cfg);
				ctx.ui.notify("defaults restored (Pi's own compaction settings are untouched)", "info");
				continue;
			}
			default:
				continue;
		}
	}
}

// --- factory ----------------------------------------------------------------

export default function cliffcompaction(pi: ExtensionAPI): void {
	pi.registerFlag("cliff-shadow", {
		description: "CliffCompaction: compute and report, but modify no request",
		type: "boolean",
	});

	pi.on("session_start", async (_event, ctx) => {
		const paths: ConfigPaths = { agentDir: getAgentDir(), cwd: ctx.cwd };
		const flags: CliffConfigInput = {};
		if (pi.getFlag("cliff-shadow") === true) flags.shadow = true;
		const loaded = loadConfig(paths, flags);
		state = {
			cfg: loaded.cfg,
			paths,
			warnings: loaded.warnings,
			sources: loaded.sources,
			last: null,
			compactions: 0,
		};
		updateStatus(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const s = state;
			if (!s) return undefined;

			// `/compact <instructions>` asks for a focused summary, and mechanical
			// truncation cannot honour instructions. Let Pi's summariser do it.
			if (shouldDeferToPi({ reason: event.reason, customInstructions: event.customInstructions, cfg: s.cfg })) {
				return undefined;
			}

			const prep = event.preparation as unknown as Preparation;
			const entries = (event.branchEntries ?? []) as readonly SessionEntryLike[];
			const plan = planCompaction({
				prep,
				cfg: s.cfg,
				previous: previousCompaction(entries),
			});

			s.compactions++;
			s.last = {
				reason: event.reason,
				before: plan.tokensBefore,
				originalChars: plan.stats.originalChars,
				droppedChars: plan.stats.droppedChars,
				excerptedChars: plan.stats.excerptedChars,
				split: prep.isSplitTurn,
				shadow: s.cfg.shadow,
			};
			updateStatus(ctx);

			// The digest is empty, which means truncation removed everything. Pi's
			// LLM summary is lossy too, but it is better than an empty region.
			if (plan.summary.trim() === SUMMARY_HEADER) return undefined;

			if (s.cfg.shadow) return undefined;

			return {
				compaction: {
					summary: plan.summary,
					firstKeptEntryId: plan.firstKeptEntryId,
					tokensBefore: plan.tokensBefore,
					details: plan.details,
				},
			};
		} catch {
			// Fail open: Pi's own summariser is always the fallback.
			return undefined;
		}
	});

	pi.registerCommand("cliffcompaction", {
		description: "CliffCompaction: status, threshold, and policy knobs",
		handler: async (args, ctx) => {
			const verb = args.trim().split(/\s+/)[0] ?? "";
			if (verb === "status") {
				ctx.ui.notify(statusText(ctx), "info");
				return;
			}
			if (verb === "apply") {
				const msg = await applyThreshold(ctx);
				ctx.ui.notify(msg, msg.startsWith("applied") ? "info" : "warning");
				if (msg.startsWith("applied")) await ctx.reload();
				return;
			}
			await menu(ctx);
		},
	});
}
