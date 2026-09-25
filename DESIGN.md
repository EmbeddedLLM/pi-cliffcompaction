# Design

Why this extension is shaped the way it is, what it deviates from, and which
claims rest on measurement rather than assumption.

Reference: *CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding
Agents* (Nguyen, Cho, Chen, Dettmers) — <https://arxiv.org/abs/2609.26779>.
Upstream implementation: <https://github.com/nguyenvuthientrang/cliffcompaction>.

## 1. Pi already implements the mechanism

CliffCompaction's contribution is usually described as the algorithm. In Pi, most
of the algorithm is already there:

| CliffCompaction | Pi equivalent |
|---|---|
| `[head] + [one summary] + [last K turns verbatim]` | `buildContextEntries()`: compaction entry (system checkpoint + `compactionSummary`), then entries from `firstKeptEntryId` to the leaf |
| compact at a token threshold | `shouldCompact(contextTokens, contextWindow, settings)` |
| never cut at a tool result | `findProjectedCutPoint()` — cut points are user/assistant/bashExecution/custom/branchSummary/compactionSummary |
| substitute at send time; original history untouched | `buildSessionProjection()` applies `context_edit` to model context only |
| grow untouched, then drop (`cliff`) | context is only rebuilt at a compaction boundary |

The one non-cliff part is the summary itself. Pi calls `generateSummary(..., previousSummary)`
with an *update prompt to merge*, which produces exactly the summary-of-summaries
chain the paper exists to prevent.

**So this extension replaces the summary generator and nothing else.** That is why
it is a few hundred lines rather than a port of the upstream proxy's ~3,900.

## 2. How the paper's three design choices are obtained

The paper makes three choices (§2):

1. **Compact at a token threshold.** Pi's `shouldCompact`, driven by
   `compaction.reserveTokens`.
2. **Retain compact verbatim excerpts, drop token-intensive portions.** This module.
3. **Never nest: discard the previous compaction, compact only the live session.**

Choices 1 and 3 hold largely for free, and 3 holds *more* robustly than in the
paper's own description, because of how Pi prepares a compaction
(`core/compaction/compaction.js`):

```js
const prevCompactionIndex = projectedEntries.findIndex(
  (e) => e.sourceEntry.type === "compaction" && e.messages.length > 0);
let boundaryStart = 0;
if (prevCompactionIndex >= 0) {
  previousSummary = projectedEntries[prevCompactionIndex].sourceEntry.summary;
  boundaryStart = prevCompactionIndex + 1;      // <- prior summary excluded
}
const messagesToSummarize = projectedEntries
  .slice(boundaryStart, historyEnd)
  .flatMap(getMessagesFromProjectedEntryForCompaction);
```

`messagesToSummarize` already starts *after* the previous compaction, so it
contains original content only. `previousSummary` is passed separately. **The
paper's third choice therefore reduces to never reading `previousSummary`** — no
bookkeeping, no state. As belt-and-braces, `compactionSummary` messages that reach
the serializer anyway are dropped (`serialize.ts`).

A second load-bearing fact: `messagesToSummarize` is built from the **projection**,
so content edited via `context_edit` is reflected. Anything we stub is therefore
visible to the next compaction, and the two mechanisms compose rather than fight.

## 3. Deviations ledger

Be explicit about what is and is not a deviation from the paper.

### Faithful

- Truncate/drop only; nothing is rephrased, so drift cannot accumulate.
- Never compact a compaction.
- Zero auxiliary LLM calls. Our `CompactionResult` carries no `usage` because no
  model call was made — this is the paper's headline mechanism, and it lands on
  the most expensive call Pi makes (a full-context summarisation input).
- Threshold-triggered, batched cliff.

### Forced by the host (not deviations, adaptations)

- **`<read-files>` / `<modified-files>` are synthesised by us.** Pi carries file
  lists cumulatively across its own compactions, but
  `extractFileOperations()` only inherits from a previous compaction when
  `!prevCompaction.fromHook`. Our summary is `fromHook: true`, so we must carry
  our own `details` forward and render the tags.
- **Pi-specific roles.** `bashExecution`, `custom`, `branchSummary`,
  `compactionSummary` have no counterpart in the paper or the upstream proxy.
  Policy per role is in §4.
- **Signed thinking blocks are never re-sent from the compacted region**, only
  their text. A signature without its block is unusable, and the recent window
  keeps the signed block intact because kept messages are passed by reference.

### Rule changes inside the paper's primitives

- **Tool-aware drop policy.** The paper drops every tool result over 500 chars,
  justified by: *"If the model wants to retrieve past information, it can issue a
  new tool call from the preserved signature, so any removed context remains
  recoverable."* That premise holds for re-runnable tools and fails for
  side-effecting ones — re-issuing `bash` may run a destructive command twice.
  Measured on 64 real Pi sessions: `read` is **29.7%** of all context chars and
  95% of its results exceed 500 chars (re-runnable → drop); `bash` is **23.4%**
  and only 54% exceed 500 chars (side-effecting → excerpt). Excerpting rather
  than dropping costs roughly 4 percentage points of total context, which is
  cheap insurance. An excerpt is still truncation, so this stays inside the
  paper's primitive set.
- **`isError` results are never dropped** — highest signal, and the proxy had no
  such signal.
- **Unknown tools are excerpted rather than dropped** (safe default, overridable).
- **Thinking is capped at 2000 chars, not the paper's 300.** See §6.

### Genuine deviations

- **`recentMode: "tokens-snapped"` is the default** (see §5). The paper cuts on
  turn boundaries (`turns[:-2K]`, "K turn pairs"); Pi's stock cut is
  token-denominated and may split a turn. Snapping restores the paper's precision
  property with a bounded emergency split. `recentMode: "turns"` reproduces
  Algorithm 1 exactly.
- **`thresholdTokens` defaults to 250k, not the paper's 8k–45k.** Explicitly the
  operator's choice: a bounded but generous context.
- **`context_edit` eviction is not implemented.** This is the one idea that
  directly contradicts the paper ("Instead of actively managing the context
  throughout a trajectory, CliffCompaction leaves it unchanged and lets it grow
  naturally, compacting only upon exhausting a preset budget"). At a 250k
  threshold it would fire almost never. Reserved as a config key; not built.

## 4. Content policy

Per-message, applied to the **compacted region only**. The kept window
(`firstKeptEntryId` … leaf) is passed by reference and never rebuilt, so no cap
below touches it.

| Content | Treatment |
|---|---|
| assistant thinking | `thinking: …`, capped per message (`thinkingMode: keep`); signature dropped |
| assistant visible text | `assistant: …`, capped by `thoughtMaxChars` (0 = unlimited) |
| assistant tool call | `[name] {args}` with args capped by `cmdMaxChars` |
| tool result, ≤ `resultMaxChars` | verbatim |
| tool result, `isError` | kept, excerpted if long — never dropped |
| tool result, re-runnable tool | dropped entirely if long; the call signature is the recovery path |
| tool result, side-effecting tool | head + tail excerpt with an explicit omitted-char count |
| user text | verbatim, capped by `humanMaxChars` |
| prior `compactionSummary` | **dropped** — the "never compact a compaction" enforcement point |
| `branchSummary` | kept: the only carrier of the abandoned branch |
| `custom` | kept: extension-injected context |
| `bashExecution` | `$ command` + excerpt; skipped when `excludeFromContext` |
| `system` | not folded in — Pi's compaction entry carries the checkpoint |
| images | dropped from the compacted region |

The header is deliberately honest: *"The following is a summary of your previous
actions (long observations omitted)"*. We do not imitate Pi's
`## Key Decisions` format, because filling semantic-sounding headings with
mechanical content would misrepresent it to the model.

## 5. The kept window

`keepRecentTokens` is Pi's knob and we keep Pi's unit, because Pi's is
token-denominated and cannot overflow the budget by construction.

The problem it creates: `isTurnStartMessage` excludes `assistant` while
`isCutPointMessage` includes it, and assistant messages outnumber user messages
roughly 8:1. So `cutPoints.find(c => c >= i)` usually lands on an assistant
message and `isSplitTurn` fires on **most** compactions, LLM-summarising the
early part of the current turn while keeping the rest verbatim.

`tokens-snapped` fixes this cheaply. Because `messagesToSummarize` is
`slice(boundaryStart, historyEnd)` with `historyEnd = turnStartIndex` when split,
Pi has *already* excluded the turn prefix from it. So:

```
cut     = enclosing turn start of preparation.firstKeptEntryId   // itself when not split
summary = serialize(preparation.messagesToSummarize)
// preparation.turnPrefixMessages is intentionally not summarised: kept verbatim
```

The only cost is overshoot, bounded by the prefix length and guarded by
`maxTurnOvershoot` using Pi's own `estimateTokens`. Unbounded overshoot could
push post-compaction context back over the trigger and thrash; at a 250k
threshold the headroom makes that essentially unreachable.

## 6. Why 2000 for thinking

The paper truncates thinking to 300 chars, justified by *"Agent thoughts … are
not a major source of context bloat"*. That holds in their setting, where tool
traffic is 84% of tokens. It does not hold here: **thinking is 25.1% of all
context chars** across 64 real Pi sessions.

Since the digest retains thinking at its cap, the cap largely determines the
cliff depth. For a 230k-token compacted region:

| `thinkingMaxChars` | digest | post-compaction | cliff |
|---|---|---|---|
| 0 (unlimited) | ~89k | ~130k | shallow; ~2.5× more compactions |
| **2000 (default)** | **~60k** | **~100k** | **balanced** |
| 300 (paper) | ~36k | ~76k | deepest |

2000 roughly halves thinking's contribution while keeping the substance.
Truncating the *visible* assistant text (`thoughtMaxChars`) is a different matter
and defaults to unlimited: it is only 5.9% of context, so capping it saves
almost nothing while risking exactly the plan statements the paper's precision
argument wants to protect.

## 7. Trigger semantics

Pi has exactly one lever, and our threshold is its complement:

```
Pi fires when  contextTokens > contextWindow − reserveTokens
we want it at  contextTokens > thresholdTokens
=>             reserveTokens = max(reserveFloor, contextWindow − thresholdTokens)
B            = min(thresholdTokens, contextWindow − reserveFloor)
```

`reserveFloor` (default 16384, Pi's own default) is headroom for a *normal turn*,
not the model's maximum output. Max output is a capability ceiling, not a
per-turn requirement: a 1M-window model with a 256k max output must still permit
a 250k threshold. Pi has compact-and-retry recovery if a response overruns.

Because windows differ per model, the applied form belongs in
`compaction.modelOverrides`, one `reserveTokens` per model. `keepRecentTokens`
can stay global — Pi resolves the two independently.

`reserveTokens` also feeds the summarisation *output* cap (capped at the model's
max output). At large values that is generous: inert for our path, which makes no
model call, and merely permissive for the fallback.

## 8. Measurements

Corpus: 64 real Pi sessions, 21.6M context chars, 4,720 tool results.

Context composition:

| class | share |
|---|---|
| tool results | 56.3% |
| — `read` | 29.7% |
| — `bash` | 23.4% |
| tool-call arguments | ~7.9% |
| thinking | 25.1% |
| assistant visible text | 5.9% |
| user | 4.8% |

The paper reports 56.0% tool results on Terminal-Bench; this corpus is 56.3%.
Cliff's drop target (>500-char results) is **54.9% of all context chars**.

Trigger frequency at `keepRecentTokens = 20000` (session totals: median 49k,
p90 234k, max 535k):

| budget B | compactions | sessions affected |
|---|---|---|
| 150k | 19 | 13 / 64 |
| 200k | 11 | 10 / 64 |
| 250k | 5 | 4 / 64 |
| 300k | 2 | 2 / 64 |

Consequence: at 200–300k the extension is low-risk and cheap to validate by hand,
and each avoided compaction saves one full-context summarisation input.

## 9. Paper vs upstream repo vs Pi defaults

The three disagree, which is why these are documented rather than inherited.

| Knob | Paper (Algorithm 1 / §2.2) | Upstream repo default | Pi default | Here |
|---|---|---|---|---|
| system prompt | kept (`messages[0]`) | head, verbatim | regenerated checkpoint | Pi's |
| first user message | kept (`messages[1]`) | head, verbatim | inside the summarised region | carried verbatim via `details` |
| other user messages | **not handled → dropped** | verbatim in summary | summarised | kept, capped |
| assistant thinking | `Truncate(·, 300)` | **unlimited** | summarised | 2000 |
| assistant text | `Truncate(·, 300)` | **unlimited** | summarised | unlimited |
| tool call | `Signature(·, 150)` | 150 | summarised | 150 |
| tool result ≤ 500 | kept | kept | summarised | kept |
| tool result > 500 | dropped | dropped | summarised | dropped (re-runnable) / excerpted (side-effecting) |
| recent window | last `2K` messages | `keep_recent = 3` turns | 20k tokens | 40k tokens, snapped |
| threshold | 8k–45k | 100k–200k (README) | window − 16384 | 250k |
| drop thinking | — | `CLIFF_KEEP_THINKING=0` | — | `thinkingMode: drop` |
| mid-trajectory eviction | **explicitly rejected** | — | — | not built |

Two discrepancies worth remembering:

- **The paper contradicts itself on user messages.** §2.2 claims high precision
  "because it preserves user directives and model generations in full for two
  full compaction windows", but Algorithm 1 has no `User` branch, so a
  mid-conversation directive contributes nothing to the compacted block. The
  upstream repo resolved this in the prose's favour by keeping human text
  verbatim. We do too, which is a deviation *from the pseudocode* and consistent
  with the stated intent.
- **The upstream repo's defaults are looser than the paper's evaluated settings**
  (thinking unlimited vs 300; README thresholds 100k–200k vs the paper's 8k–45k).
  Inheriting "the reference implementation's defaults" would not reproduce the
  paper.

## 10. Not in v1

- **`context_edit` eviction** (§3).
- **Branch summarisation** (`/tree`) uses a separate hook, `session_before_tree`.
  It stays LLM-based: it is a one-off on branch navigation, not part of the
  trajectory.
- **Shadow mode is on by default.** The extension computes and reports, and
  forwards nothing modified, until it is trusted.

## 11. Open items

- Verify on a live session that `messagesToSummarize` never contains a previous
  summary (source says it cannot).
- Verify that `fileOps` still populates when tool results are stubbed (source
  says yes, via `sourceEntries`).
- One smoke test that a large `reserveTokens` does not distort the fallback
  summariser's output cap.
- Golden-fixture test against a real compacted region extracted from a session,
  rather than hand-shaped fixtures.

Resolved: the threshold write-back. The menu applies it automatically — an
atomic read-modify-write of `settings.json` followed by `ctx.reload()`, which is
what makes Pi re-read settings from disk. There is no supported alternative:
`SettingsManager`'s public surface has no compaction setter and `/settings` does
not expose `compaction.*`. Two properties are tested rather than assumed — an
unparseable file stops the write instead of being clobbered, and every key we do
not own survives — and the panel reports the effective threshold read back from
the file, so a hand edit cannot silently disagree with what is displayed.
