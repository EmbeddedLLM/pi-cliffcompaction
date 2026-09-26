/**
 * The economics report.
 *
 * Correctness is proven elsewhere; this exists for the one claim that is not:
 * that a deep cliff is cheaper than Pi's native summarisation. The mechanism to
 * watch is the prompt cache. A compaction invalidates it, so the request right
 * after a cliff pays full price for the whole context — measured once at 242,776
 * uncached tokens with `cacheRead: 0`.
 *
 * The paper's argument is that this one-off re-prefill is amortised over a long
 * growth segment, since cached reads cost roughly 5-6x less than uncached ones.
 * `requestsPerCycle` is therefore the number that decides it: how many requests
 * each cliff pays for.
 *
 * It also counts cache misses that are *not* caused by compaction. A provider TTL
 * expiry looks identical in the usage numbers but has nothing to do with this
 * extension, and attributing it here would flatter the report.
 *
 * Pure: samples in, report out, so the arithmetic is unit-testable.
 */

export interface RequestSample {
	/** Uncached input tokens. */
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite?: number;
	readonly output: number;
	readonly costUsd?: number;
	/** A compaction entry immediately precedes this request on the branch. */
	readonly afterCompaction?: boolean;
}

export interface CacheReport {
	readonly requests: number;
	readonly uncachedInput: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	readonly costUsd: number | null;
	readonly compactions: number;
	/** Requests that immediately follow a compaction: the re-prefills. */
	readonly reprefillRequests: number;
	readonly reprefillTokens: number;
	/** Share of all uncached input spent on re-prefills. */
	readonly reprefillShare: number;
	/** cached / (cached + uncached) */
	readonly cacheHitRate: number;
	/** Requests per compaction: how long each cliff is amortised over. */
	readonly requestsPerCycle: number | null;
	/** Cache collapses that no compaction explains — e.g. a provider TTL expiry. */
	readonly silentMisses: number;
	readonly peakContextTokens: number;
	/** Context size per request, for the sawtooth. */
	readonly contextTokens: readonly number[];
}

/** Cached share below this, relative to the previous context, counts as a collapse. */
const MISS_RATIO = 0.5;

export function buildCacheReport(
	samples: readonly RequestSample[],
	compactions: number,
): CacheReport {
	let uncachedInput = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let output = 0;
	let cost = 0;
	let haveCost = false;
	let reprefillRequests = 0;
	let reprefillTokens = 0;
	let silentMisses = 0;
	let peakContextTokens = 0;
	let prevContext = 0;
	const contextTokens: number[] = [];

	for (const s of samples) {
		const written = s.cacheWrite ?? 0;
		const context = s.input + s.cacheRead + written;
		uncachedInput += s.input;
		cacheRead += s.cacheRead;
		cacheWrite += written;
		output += s.output;
		if (typeof s.costUsd === "number" && Number.isFinite(s.costUsd)) {
			cost += s.costUsd;
			haveCost = true;
		}
		peakContextTokens = Math.max(peakContextTokens, context);
		contextTokens.push(context);

		if (s.afterCompaction) {
			reprefillRequests++;
			reprefillTokens += s.input;
		} else if (prevContext > 0 && s.cacheRead < prevContext * MISS_RATIO) {
			// A cache that collapsed with no compaction to explain it. Reported
			// separately so it cannot be read as a cost of this extension.
			silentMisses++;
		}
		prevContext = context;
	}

	const billable = cacheRead + uncachedInput;
	return {
		requests: samples.length,
		uncachedInput,
		cacheRead,
		cacheWrite,
		output,
		costUsd: haveCost ? cost : null,
		compactions,
		reprefillRequests,
		reprefillTokens,
		reprefillShare: uncachedInput > 0 ? reprefillTokens / uncachedInput : 0,
		cacheHitRate: billable > 0 ? cacheRead / billable : 0,
		requestsPerCycle: compactions > 0 ? samples.length / compactions : null,
		silentMisses,
		peakContextTokens,
		contextTokens,
	};
}

const BARS = "▁▂▃▄▅▆▇█";

/** Sparkline of a series, scaled between its own extremes. */
export function sparkline(values: readonly number[], width = 48): string {
	if (values.length === 0) return "";
	// Downsample by taking the max of each bucket, so a cliff never disappears.
	const n = Math.min(width, values.length);
	const buckets: number[] = [];
	for (let b = 0; b < n; b++) {
		const from = Math.floor((b * values.length) / n);
		const to = Math.max(from + 1, Math.floor(((b + 1) * values.length) / n));
		let m = 0;
		for (let i = from; i < to && i < values.length; i++) m = Math.max(m, values[i] ?? 0);
		buckets.push(m);
	}
	const lo = Math.min(...buckets);
	const hi = Math.max(...buckets);
	const span = hi - lo;
	let out = "";
	for (const v of buckets) {
		const f = span > 0 ? (v - lo) / span : 0.5;
		out += BARS[Math.min(Math.max(Math.round(f * (BARS.length - 1)), 0), BARS.length - 1)];
	}
	return out;
}

function k(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(Math.round(n));
}

function pct(x: number): string {
	return `${Math.round(x * 100)}%`;
}

export function formatCacheReport(r: CacheReport): string {
	if (r.requests === 0) return "cliff cache: no completed requests in this session yet";
	const lines: string[] = [];
	lines.push(`cliff cache — ${r.requests} request(s), ${r.compactions} compaction(s)`);
	lines.push(`context   ${sparkline(r.contextTokens)}   peak ${k(r.peakContextTokens)}`);
	lines.push(`tokens    cached ${k(r.cacheRead)} (${pct(r.cacheHitRate)}) · uncached ${k(r.uncachedInput)} · out ${k(r.output)}`);
	if (r.costUsd !== null) lines.push(`cost      $${r.costUsd.toFixed(4)}`);
	lines.push(
		`cliffs    ${r.compactions} compaction(s); ${r.reprefillRequests} request(s) immediately after,` +
			` costing ${k(r.reprefillTokens)} uncached (${pct(r.reprefillShare)} of all uncached input)`,
	);
	// Deliberately no causal claim. A low number here means the prefix was still
	// cached, which can be a genuinely cheap cliff or a provider that still had the
	// same content (e.g. the identical session replayed). The report cannot tell
	// those apart, so it does not try.
	if (r.compactions > 0 && r.reprefillShare < 0.5) {
		lines.push("note      that request was served from cache — not a full re-prefill");
	}
	lines.push(
		r.requestsPerCycle === null
			? "amortise  no compaction yet this session"
			: `amortise  ${r.requestsPerCycle.toFixed(1)} requests per cliff`,
	);
	if (r.silentMisses > 0) {
		lines.push(`misses    ${r.silentMisses} cache collapse(s) with no compaction — TTL expiry?`);
	}
	return lines.join("\n");
}
