/**
 * Cache accounting. The arithmetic here decides whether the whole idea pays for
 * itself, so it is tested against constructed series rather than a live session.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type RequestSample, buildCacheReport, formatCacheReport, sparkline } from "./report.ts";

const s = (o: Partial<RequestSample>): RequestSample => ({ input: 0, cacheRead: 0, output: 0, ...o });

test("totals add up across the three token classes", () => {
	const r = buildCacheReport(
		[
			s({ input: 100, cacheRead: 900, output: 50, costUsd: 0.01 }),
			s({ input: 200, cacheRead: 800, cacheWrite: 10, output: 60, costUsd: 0.02 }),
		],
		0,
	);
	assert.equal(r.uncachedInput, 300);
	assert.equal(r.cacheRead, 1700);
	assert.equal(r.cacheWrite, 10);
	assert.equal(r.output, 110);
	assert.equal(Number(r.costUsd?.toFixed(4)), 0.03);
});

test("cost is null unless at least one sample reports it", () => {
	assert.equal(buildCacheReport([s({ input: 1 })], 0).costUsd, null);
	assert.equal(buildCacheReport([], 0).costUsd, null);
	assert.equal(buildCacheReport([s({ input: 1, costUsd: 0 })], 0).costUsd, 0);
});

test("a re-prefill is a request that follows a compaction", () => {
	// The cliff: a big session, then a compaction, then a fully uncached request.
	const r = buildCacheReport(
		[
			s({ input: 10, cacheRead: 240_000, output: 100 }),
			s({ input: 242_000, cacheRead: 0, output: 90, afterCompaction: true }),
			s({ input: 20, cacheRead: 200_000, output: 80 }),
		],
		1,
	);
	assert.equal(r.reprefillRequests, 1);
	assert.equal(r.reprefillTokens, 242_000);
	assert.equal(r.reprefillShare, 242_000 / 242_030);
	assert.equal(r.silentMisses, 0, "the compaction explains it, so it is not a silent miss");
});

test("a cache collapse with no compaction is counted separately", () => {
	// A TTL expiry looks the same in the usage numbers but is not ours to claim.
	const r = buildCacheReport(
		[
			s({ input: 10, cacheRead: 240_000 }),
			s({ input: 241_000, cacheRead: 0 }),
		],
		0,
	);
	assert.equal(r.silentMisses, 1);
	assert.equal(r.reprefillRequests, 0);
});

test("a partial cache read is not a collapse", () => {
	const r = buildCacheReport([s({ input: 10, cacheRead: 100 }), s({ input: 10, cacheRead: 60 })], 0);
	assert.equal(r.silentMisses, 0, "60% of the previous context is still a hit");
});

test("the first request is never a miss", () => {
	assert.equal(buildCacheReport([s({ input: 5_000, cacheRead: 0 })], 0).silentMisses, 0);
});

test("requests per cycle is the amortisation of a cliff", () => {
	assert.equal(buildCacheReport(Array.from({ length: 30 }, () => s({ input: 1 })), 3).requestsPerCycle, 10);
	assert.equal(buildCacheReport([s({ input: 1 })], 0).requestsPerCycle, null);
});

test("cache hit rate ignores nothing", () => {
	const r = buildCacheReport([s({ input: 250, cacheRead: 750 })], 0);
	assert.equal(r.cacheHitRate, 0.75);
	assert.equal(buildCacheReport([], 0).cacheHitRate, 0);
});

test("peak context is tracked across the series", () => {
	const r = buildCacheReport([s({ input: 1_000 }), s({ input: 1, cacheRead: 250_000 }), s({ input: 2 })], 0);
	assert.equal(r.peakContextTokens, 250_001);
});

test("cacheWrite counts toward context size", () => {
	const r = buildCacheReport([s({ input: 1, cacheWrite: 500 })], 0);
	assert.equal(r.contextTokens[0], 501);
	assert.equal(r.peakContextTokens, 501);
});

// --- sparkline --------------------------------------------------------------

test("sparkline is empty for no data and one cell for one sample", () => {
	assert.equal(sparkline([]), "");
	assert.equal(sparkline([5]).length, 1);
});

test("sparkline never drops a cliff when downsampling", () => {
	// 200 samples, one of them huge. Bucketing by max means the spike survives.
	const values = Array.from({ length: 200 }, (_, i) => (i === 137 ? 250_000 : 1_000));
	const line = sparkline(values, 40);
	assert.equal([...line].length, 40);
	assert.ok(line.includes("█"), "the spike is represented at full height");
	assert.ok(!line.startsWith("█"), "the baseline is not flattened to the top");
});

test("a flat series does not get amplified to full height", () => {
	const line = sparkline([1_000, 1_000, 1_000], 3);
	assert.equal(line, "▅▅▅", "no noise to exaggerate");
});

// --- rendering --------------------------------------------------------------

test("the report renders the amortisation and the TTL caveat", () => {
	const text = formatCacheReport(
		buildCacheReport(
			[
				s({ input: 10, cacheRead: 240_000, output: 100, costUsd: 0.01 }),
				s({ input: 242_000, cacheRead: 0, output: 90, afterCompaction: true, costUsd: 0.5 }),
				s({ input: 20, cacheRead: 200_000, output: 80, costUsd: 0.01 }),
				s({ input: 201_000, cacheRead: 0, output: 70, costUsd: 0.4 }),
			],
			1,
		),
	);
	assert.ok(text.includes("1 compaction(s)"), text);
	assert.ok(text.includes("immediately after"), text);
	assert.ok(text.includes("requests per cliff"), text);
	assert.ok(text.includes("TTL expiry?"), text);
	assert.ok(!text.includes("served from cache"), "this one really was a full re-prefill");
	assert.ok(text.includes("$0.9200"), text);
});

test("an empty session says so rather than printing zeros", () => {
	assert.equal(formatCacheReport(buildCacheReport([], 0)), "cliff cache: no completed requests in this session yet");
});

test("a post-cliff request served from cache is called out, not claimed as a cost", () => {
	// Observed for real: replaying the identical session against the same provider
	// produced a cache hit on the request after the cliff. The report must not
	// present that as the cliff's price either way.
	const text = formatCacheReport(
		buildCacheReport(
			[
				s({ input: 270, cacheRead: 467_264 }),
				s({ input: 216, cacheRead: 242_560, afterCompaction: true }),
			],
			1,
		),
	);
	assert.ok(text.includes("served from cache"), text);
	assert.ok(!text.includes("TTL expiry?"));
});
