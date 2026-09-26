/**
 * Configuration for the compaction policy.
 *
 * Pure: no file I/O here, so the resolution logic is unit-testable and the
 * loader can stay thin. Precedence, highest first: CLI flag, project config,
 * user config, built-in default.
 */

import { DEFAULT_TOOL_POLICY, type ToolClass, type ToolPolicy } from "./policy.ts";

export type ThinkingMode = "keep" | "drop";

export interface CliffConfig {
	// --- trigger -------------------------------------------------------------
	/** B: the peak context at which compaction fires. Written to Pi as
	 *  `reserveTokens = max(reserveFloor, contextWindow - thresholdTokens)`. */
	thresholdTokens: number;
	/** Headroom kept for the response. A normal-turn allowance, not the model's
	 *  maximum output: that is a capability ceiling, not a per-turn requirement. */
	reserveFloor: number;

	// --- kept window ---------------------------------------------------------
	/** Verbatim window kept after a cliff. Pi's own knob, and the only one: its
	 *  token-denominated cut already lands on cliff's turn boundaries. */
	keepRecentTokens: number;

	// --- compacted-region policy --------------------------------------------
	/** Tool results longer than this are dropped or excerpted. */
	resultMaxChars: number;
	/** Tool-call signature (serialized arguments) cap. */
	cmdMaxChars: number;
	thinkingMode: ThinkingMode;
	/** Per assistant message. 0 = unlimited. */
	thinkingMaxChars: number;
	/** Per assistant message, visible text only. 0 = unlimited. */
	thoughtMaxChars: number;
	/** Per user message. 0 = unlimited. */
	humanMaxChars: number;
	excerptHead: number;
	excerptTail: number;
	toolPolicy: ToolPolicy;

	// --- behaviour -----------------------------------------------------------
	/** `/compact <instructions>` falls through to Pi's LLM summarizer: the
	 *  instructions focus the summary, and mechanical truncation cannot honour them. */
	honorManualInstructions: boolean;
	/** Compute and report, but never modify a request. */
	shadow: boolean;
}

export const DEFAULT_CONFIG: CliffConfig = {
	thresholdTokens: 250_000,
	reserveFloor: 16_384,
	keepRecentTokens: 40_000,

	resultMaxChars: 500,
	cmdMaxChars: 150,
	thinkingMode: "keep",
	/**
	 * Chosen from the measured distribution rather than by feel. Thinking blocks are
	 * extremely heavy-tailed: median 116 chars, p90 932, max 332,753 — and the top
	 * 3% of blocks hold 74% of all thinking text. The cap curve is therefore flat:
	 * 300 removes 84.5%, 1000 removes 73.0%, 2000 removes 68.1%, 4000 removes 65.0%.
	 * 4000 sits at the flat end, so it costs ~1-2% of the digest over 2000 while
	 * keeping noticeably more of the reasoning; the aggressive setting is 300.
	 */
	thinkingMaxChars: 4000,
	thoughtMaxChars: 0,
	humanMaxChars: 20_000,
	excerptHead: 300,
	excerptTail: 200,
	toolPolicy: DEFAULT_TOOL_POLICY,

	honorManualInstructions: true,
	shadow: true,
};

/** A partial config in which the one nested object is also partial. */
export type CliffConfigInput = Partial<Omit<CliffConfig, "toolPolicy">> & {
	toolPolicy?: Partial<ToolPolicy>;
};

function mergeToolPolicy(base: ToolPolicy, over?: Partial<ToolPolicy>): ToolPolicy {
	if (!over) return base;
	return {
		dropTools: over.dropTools ?? base.dropTools,
		excerptTools: over.excerptTools ?? base.excerptTools,
		unknown: (over.unknown as ToolClass | undefined) ?? base.unknown,
		alwaysKeepErrors: over.alwaysKeepErrors ?? base.alwaysKeepErrors,
	};
}

/** Deep-ish merge; later inputs win. Only `toolPolicy` is nested. */
export function resolveConfig(...inputs: readonly (CliffConfigInput | undefined)[]): CliffConfig {
	let out: CliffConfig = { ...DEFAULT_CONFIG, toolPolicy: { ...DEFAULT_TOOL_POLICY } };
	for (const input of inputs) {
		if (!input) continue;
		const { toolPolicy, ...rest } = input;
		out = { ...out, ...(rest as Partial<CliffConfig>) };
		out.toolPolicy = mergeToolPolicy(out.toolPolicy, toolPolicy);
	}
	return out;
}

/**
 * Pi's trigger and ours are the same number seen from opposite ends:
 *
 *   Pi fires when  contextTokens > contextWindow - reserveTokens
 *   we want it at  contextTokens > thresholdTokens
 *   =>             reserveTokens = contextWindow - thresholdTokens
 *
 * Clamped so that a threshold at or beyond the window degrades to the floor
 * instead of producing a zero (or negative) reserve.
 */
export function reserveTokensFor(cfg: CliffConfig, contextWindow: number): number {
	return Math.max(cfg.reserveFloor, contextWindow - cfg.thresholdTokens);
}

/** The inverse: the threshold Pi is actually operating at. */
export function effectiveThreshold(contextWindow: number, reserveTokens: number): number {
	return contextWindow - reserveTokens;
}
