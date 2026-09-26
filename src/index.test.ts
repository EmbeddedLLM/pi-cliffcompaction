/**
 * Integration: the extension factory against a fake Pi host.
 *
 * Covers the two things that matter most and cannot be checked from the pure
 * modules: that the handler *fails open* rather than throwing into Pi, and that
 * applying the threshold actually lands the right number in settings.json.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { DEFAULT_CONFIG } from "./config.ts";
import cliffcompaction from "./index.ts";
import { SUMMARY_HEADER } from "./serialize.ts";

const roots: string[] = [];
function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	roots.push(d);
	return d;
}

after(() => {
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// `getAgentDir()` reads this at call time, so the extension picks up the
// sandbox without any injection.
const agentDir = tmp("cliff-agent-");
process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = tmp("cliff-cwd-");

const userConfigPath = () => join(agentDir, "cliffcompaction.json");
const settingsPath = () => join(agentDir, "settings.json");

// Every test starts from a clean sandbox: state is module-global, and one
// test's settings.json would otherwise be read by the next.
beforeEach(() => {
	writeFileSync(userConfigPath(), "{}", "utf8");
	writeFileSync(settingsPath(), "{}", "utf8");
});

// --- fakes ------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi(flags: Record<string, boolean | string> = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const registered: string[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerFlag(name: string, _opts: unknown) {
			registered.push(`flag:${name}`);
		},
		getFlag(name: string) {
			return flags[name];
		},
		registerCommand(name: string, opts: { handler: Handler }) {
			registered.push(`cmd:${name}`);
			commands.set(name, opts);
		},
	};
	return {
		pi: pi as unknown as Parameters<typeof cliffcompaction>[0],
		handlers,
		commands,
		registered,
	};
}

function fakeCtx(over: { contextWindow?: number; select?: () => Promise<string | undefined> } = {}) {
	const notifications: string[] = [];
	const statuses: string[] = [];
	const writes: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		model: { provider: "prov", id: "model", contextWindow: over.contextWindow ?? 1_000_000 },
		ui: {
			notify: (m: string) => notifications.push(m),
			setStatus: (_k: string, v: string) => statuses.push(v),
			select: over.select ?? (async () => undefined),
			input: async () => undefined,
			confirm: async () => false,
		},
		reload: async () => {
			writes.push("reload");
		},
		notifications,
		statuses,
		writes,
	};
	return ctx;
}

const user = (t: string) => ({ role: "user", content: t });
const assistant = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
const readResult = (n: number) => ({
	role: "toolResult",
	toolCallId: "c",
	toolName: "read",
	content: [{ type: "text", text: "R".repeat(n) }],
	isError: false,
});

function compactEvent(over: Record<string, unknown> = {}) {
	return {
		type: "session_before_compact",
		reason: "threshold",
		customInstructions: undefined,
		willRetry: false,
		signal: new AbortController().signal,
		branchEntries: [
			{ type: "message", id: "e0", message: { role: "user" } },
			{ type: "message", id: "e1", message: { role: "assistant" } },
			{ type: "message", id: "e2", message: { role: "user" } },
		],
		preparation: {
			firstKeptEntryId: "e2",
			messagesToSummarize: [user("the task"), assistant("looking"), readResult(4000)],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 250_000,
			fileOps: { read: new Set(["a.ts"]), written: new Set(["b.ts"]), edited: new Set() },
		},
		...over,
	};
}

function writeUserConfig(obj: unknown): void {
	writeFileSync(userConfigPath(), JSON.stringify(obj), "utf8");
}

function clearUserConfig(): void {
	writeUserConfig({});
}

// --- tests ------------------------------------------------------------------

test("the factory registers the hook, a flag, and a command", () => {
	const { pi, handlers, commands, registered } = fakePi();
	cliffcompaction(pi);
	assert.ok(handlers.has("session_start"), "session_start");
	assert.ok(handlers.has("session_before_compact"), "session_before_compact");
	assert.ok(commands.has("cliffcompaction"), "cliffcompaction command");
	assert.ok(registered.some((r) => r.startsWith("flag:")));
});

test("the default is active: applying the threshold is the opt-in", () => {
	// Shadow-on-by-default was a second gate that only caused confusion: without a
	// threshold applied the extension is inert anyway, because Pi fires at
	// window - reserveFloor.
	assert.equal(DEFAULT_CONFIG.shadow, false);
});

test("shadow mode, when asked for, modifies nothing", async () => {
	writeUserConfig({ shadow: true });
	const { pi, handlers } = fakePi();
	cliffcompaction(pi);
	const ctx = fakeCtx();
	await handlers.get("session_start")?.({}, ctx);

	const result = await handlers.get("session_before_compact")?.(compactEvent(), ctx);
	assert.equal(result, undefined, "shadow returns nothing, so Pi keeps its own summary");
	assert.ok(ctx.statuses.some((s) => s.includes("shadow")), "status shows shadow");
});

test("active mode returns a mechanical digest with our cut and details", async () => {
	writeUserConfig({ shadow: false });
	const { pi, handlers } = fakePi();
	cliffcompaction(pi);
	const ctx = fakeCtx();
	await handlers.get("session_start")?.({}, ctx);

	const result = (await handlers.get("session_before_compact")?.(compactEvent(), ctx)) as {
		compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: Record<string, unknown> };
	};

	assert.ok(result.compaction.summary.startsWith(SUMMARY_HEADER));
	assert.ok(!result.compaction.summary.includes("RRRR"), "the long read result was dropped");
	assert.ok(result.compaction.summary.includes("assistant: looking"));
	assert.equal(result.compaction.firstKeptEntryId, "e2");
	assert.equal(result.compaction.tokensBefore, 250_000);
	assert.equal(result.compaction.details.readFiles instanceof Array, true);
	assert.deepEqual(result.compaction.details.readFiles, ["a.ts"]);
	assert.deepEqual(result.compaction.details.modifiedFiles, ["b.ts"]);
	assert.ok(result.compaction.summary.includes("<read-files>\na.ts\n</read-files>"));
});

test("a split task folds its prefix into the digest and keeps Pi's cut", async () => {
	writeUserConfig({ shadow: false });
	const { pi, handlers } = fakePi();
	cliffcompaction(pi);
	const ctx = fakeCtx();
	await handlers.get("session_start")?.({}, ctx);

	const event = compactEvent();
	(event.preparation as Record<string, unknown>).isSplitTurn = true;
	(event.preparation as Record<string, unknown>).turnPrefixMessages = [assistant("early part of the task")];

	const result = (await handlers.get("session_before_compact")?.(event, ctx)) as {
		compaction: { firstKeptEntryId: string; summary: string; details: Record<string, unknown> };
	};
	// Pi's cut is used unchanged: moving it to the turn start would keep the whole
	// user-message span, which in an agent run is the entire task.
	assert.equal(result.compaction.firstKeptEntryId, "e2");
	assert.ok(result.compaction.summary.includes("early part of the task"), "prefix summarised");
	const details = result.compaction.details as { cliffcompaction?: { split?: boolean } };
	assert.equal(details.cliffcompaction?.split, true, "split recorded for observability");
});

test("/compact with instructions defers to Pi", async () => {
	writeUserConfig({ shadow: false });
	const { pi, handlers } = fakePi();
	cliffcompaction(pi);
	const ctx = fakeCtx();
	await handlers.get("session_start")?.({}, ctx);

	const result = await handlers.get("session_before_compact")?.(compactEvent({ reason: "manual", customInstructions: "focus on auth" }), ctx);
	assert.equal(result, undefined);
});

test("a malformed preparation fails open instead of throwing into Pi", async () => {
	writeUserConfig({ shadow: false });
	const { pi, handlers } = fakePi();
	cliffcompaction(pi);
	const ctx = fakeCtx();
	await handlers.get("session_start")?.({}, ctx);

	const result = await handlers.get("session_before_compact")?.(compactEvent({ preparation: null }), ctx);
	assert.equal(result, undefined, "no throw, no compaction: Pi's summariser runs");
});

test("`apply` writes reserveTokens and keepRecentTokens for the active model", async () => {
	clearUserConfig();
	const { pi, commands } = fakePi();
	cliffcompaction(pi);
	const ctx = fakeCtx({ contextWindow: 1_000_000 });
	const command = commands.get("cliffcompaction");
	assert.ok(command);

	await command.handler("apply", ctx);

	const written = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
		compaction: { modelOverrides: Record<string, { reserveTokens: number; keepRecentTokens: number }> };
	};
	const override = written.compaction.modelOverrides["prov/model"];
	assert.ok(override, "per-model override written");
	// 1M window, 250k default threshold -> reserve 750k.
	assert.equal(override.reserveTokens, 750_000);
	assert.equal(override.keepRecentTokens, 40_000);
	assert.ok(ctx.writes.includes("reload"), "reload requested so Pi re-reads settings");
	assert.ok(ctx.notifications.some((n) => n.startsWith("applied")));
});

test("`apply` refuses to clobber an unparseable settings.json", async () => {
	writeFileSync(settingsPath(), "{ broken");
	const { pi, commands } = fakePi();
	cliffcompaction(pi);
	const ctx = fakeCtx();
	const command = commands.get("cliffcompaction");
	assert.ok(command);

	await command.handler("apply", ctx);

	assert.ok(ctx.notifications.some((n) => n.startsWith("refusing to write")));
	assert.ok(!ctx.writes.includes("reload"));
	// The damaged file is untouched.
	assert.equal(readFileSync(settingsPath(), "utf8"), "{ broken");
});

test("`status` reports the configured and the effective threshold", async () => {
	clearUserConfig();
	const { pi, commands, handlers } = fakePi();
	cliffcompaction(pi);
	const ctx = fakeCtx({ contextWindow: 1_000_000 });
	await handlers.get("session_start")?.({}, ctx);

	const command = commands.get("cliffcompaction");
	assert.ok(command);
	await command.handler("status", ctx);

	const report = ctx.notifications.join("\n");
	assert.ok(report.includes("NOT applied"), "an unapplied threshold is called out");
	assert.ok(report.includes("250000"), "shows what was wanted");
});

test("a bad value in the config file is dropped with a warning, not applied", async () => {
	writeUserConfig({ shadow: false, thinkingMaxChars: "lots", resultMaxChars: -5 });
	const { pi, commands, handlers } = fakePi();
	cliffcompaction(pi);
	const ctx = fakeCtx();
	await handlers.get("session_start")?.({}, ctx);

	const command = commands.get("cliffcompaction");
	assert.ok(command);
	await command.handler("status", ctx);

	const report = ctx.notifications.join("\n");
	assert.ok(report.includes("thinking≤4000"), "a string cap falls back to the shipped default");
	assert.ok(report.includes("results>500"), "a negative cap is rejected, not applied");
	assert.ok(report.includes("must be a non-negative finite number"), "and the rejection is reported");
});
