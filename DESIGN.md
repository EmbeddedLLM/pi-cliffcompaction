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

- **`thresholdTokens` defaults to 250k, not the paper's 8k–45k.** Explicitly the
  operator's choice: a bounded but generous context.
- **`context_edit` eviction is not implemented.** This is the one idea that
  directly contradicts the paper ("Instead of actively managing the context
  throughout a trajectory, CliffCompaction leaves it unchanged and lets it grow
  naturally, compacting only upon exhausting a preset budget"). At a 250k
  threshold it would fire almost never. Reserved as a config key; not built.

Not a deviation after all: keeping Pi's cut unchanged. See §5 — the snap was an
attempt to fix a problem that does not exist, and it broke the normal case.

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
| first user message, on later compactions | re-emitted verbatim at the head as `[original request]` (§13) |
| images | dropped from the compacted region |

The header is deliberately honest: *"The following is a summary of your previous
actions (long observations omitted)"*. We do not imitate Pi's
`## Key Decisions` format, because filling semantic-sounding headings with
mechanical content would misrepresent it to the model.

## 5. The kept window

`keepRecentTokens` is Pi's knob and we keep Pi's unit, because Pi's is
token-denominated and cannot overflow the budget by construction. There is no
`recentMode` and no turn count: **Pi's cut is already at cliff's granularity.**
`findProjectedCutPoint` cuts at user/assistant/bashExecution/custom messages and
never at a tool result, so an assistant message and its observations always stay
together — exactly the paper's "K turn pairs".

`isSplitTurn` is a different thing. It is true when the cut lands inside a
*user-message span*, meaning the early part of the current task belongs in the
summary while the recent steps stay verbatim. That is not a structural defect and
needs no correction: both `messagesToSummarize` and `turnPrefixMessages` go into
the digest, in order.

**This was wrong in an earlier revision, and a live session is what showed it.**
The first version snapped the cut back to the enclosing turn start, on the theory
that a turn straddling the summary/verbatim boundary was a precision loss. In an
agent run the user-message span *is* the whole task, so its turn start is the
first message of the session and snapping kept everything — leaving
`messagesToSummarize` empty, the digest header-only, and the compaction a no-op
that fell back to Pi's LLM summary. Observed directly:

```
compaction 1  fromHook=False  llm_call=True   tokensBefore=8881  details=[readFiles, modifiedFiles]
```

Removing the snap made both compactions ours, with no LLM call:

```
compaction 1  fromHook=True  llm_call=False  split=True   dropped 0        kept 1 msg
compaction 2  fromHook=True  llm_call=False  split=False  dropped 21016ch  kept 1, dropped 2
```

`split` is still recorded in `details.cliffcompaction` for observability.

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
| recent window | last `2K` messages | `keep_recent = 3` turns | 20k tokens | 40k tokens (Pi's cut) |
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
  modifies nothing until it is trusted. Verified end to end: a shadow run
  produced one compaction with `fromHook: false` and a summarisation `usage`,
  i.e. Pi's own LLM summary.

## 11. Open items

- ~~Verify that `messagesToSummarize` never contains a previous summary~~ —
  confirmed on live sessions: every compaction we produced carried
  `fromHook: true` with no `usage`, and re-compaction produced a fresh digest
  rather than a merge.
- One smoke test that a large `reserveTokens` does not distort the fallback
  summariser's output cap.
- Golden-fixture test against a real compacted region extracted from a session,
  rather than hand-shaped fixtures.
- Verify `fileOps` still populates when tool results are stubbed via
  `context_edit`, if eviction is ever built (source says yes, via `sourceEntries`).

Resolved: the threshold write-back. The menu applies it automatically — an
atomic read-modify-write of `settings.json` followed by `ctx.reload()`, which is
what makes Pi re-read settings from disk. There is no supported alternative:
`SettingsManager`'s public surface has no compaction setter and `/settings` does
not expose `compaction.*`. Two properties are tested rather than assumed — an
unparseable file stops the write instead of being clobbered, and every key we do
not own survives — and the panel reports the effective threshold read back from
the file, so a hand edit cannot silently disagree with what is displayed.

## 12. Live-session measurement at the real threshold

Measured by resuming a real 546,215-token session (deepseek, 1,166 entries) with
`reserveTokens = 750000`, i.e. a genuine 250k threshold, `keepRecentTokens = 40000`,
thinking capped at 2000. Sandboxed via `PI_CODING_AGENT_DIR`; the original session
file was copied, never modified.

```
compaction 1   fromHook=True   llm_call=False   tokensBefore=546,215
               messages=1160  kept=240  dropped=59  excerpted=218
               readFiles=19  modifiedFiles=12   digest=151,523 tokens
next request   input=242,776   cacheRead=0        <- full re-prefill after the cliff
```

Zero auxiliary LLM calls, confirmed at scale: no `usage` on the compaction entry.
The file map survived. The call after the cliff read nothing from cache, which is
exactly the re-prefill the paper says a cliff costs.

Replaying the same region through the serializer offline with the same config
reproduced the digest exactly (32.7% retained; 59 dropped, 218 excerpted, 240 kept),
so the in-Pi and offline paths are identical.

### Retention is ~1/3 of the region, and that sets the cliff floor

Digest composition at the shipped caps: thinking 31.6%, tool-call signatures ~21%,
results 16.9%, assistant text 15.9%, user 14.1%. All caps verified enforced
(largest thinking block 2,014 vs cap 2,000; largest result 498 vs 500; largest user
block 20,011 vs 20,000).

Same real region under different policies:

| thinking | assistant text | digest | retained |
|---|---|---|---|
| 2000 | unlimited (shipped) | 151,523 | 32.7% |
| 2000 | 300 | 135,063 | 29.1% |
| 300 | 300 (paper) | 111,437 | 24.0% |
| dropped | unlimited | 103,413 | 22.3% |
| dropped | 300 | 86,952 | 18.7% |

So the floor is roughly

```
floor ≈ system + keepRecentTokens + retention × (threshold − system − keepRecentTokens)
```

At a 250k threshold with a ~51k system prompt and 40k keep, the region is ~159k,
the digest ~52k, and the floor ~143k — a 1.75× cliff with ~107k of growth per cycle.
Workable, but the structural fact to know is that **the digest is about a third of
the region, so the floor is about a third of the threshold**; a threshold whose
headroom is smaller than that will compact repeatedly.

The observed run compacted a 546k *backlog* (a resumed, already-oversized session),
so its floor of 240k landed just under the 250k threshold and a second compaction
followed immediately. That is a transient of resuming an oversized session, not
steady-state thrash — at steady state Pi compacts at ~B, not at 2×B.

### One bug this found

`thinkingTruncated` counted per thinking block while the cap is applied to the
message's joined text, so a message with several individually-small blocks was
truncated without being counted (17 reported against a much larger real number).
Fixed, with a regression test, and `thinkingCharsRemoved` added so the removed
volume is visible rather than implied.

## 13. The pinned original request

The paper keeps two things positionally outside the compacted region:

```
19:  s, x ← messages[0], messages[1]
20:  C, recent ← CliffCompaction(messages[2:])
21:  return LLM([s, x, C] ‖ recent)
```

`s` (system prompt) and `x` (first user message) are never handed to the
compaction function, so no compaction can touch them. Pi preserves the first of
those and not the second:

- **System prompt — preserved forever.** Pi writes a fresh `systemMessage`
  checkpoint into every compaction entry.
- **First user message — preserved for exactly one compaction.** `prepareCompaction`
  sets `boundaryStart = prevCompactionIndex + 1`, so the next region begins after
  the previous compaction entry, and the task sits before it. Verified against Pi's
  own `buildSessionContext` on a real session after one compaction:

  ```
  [0] compactionSummary (608,519 chars)   <- the task text exists only inside this
  [2] system
  entries after the compaction entry: 4   task present: false
  ```

### What the window and the digest already cover

Three scopes, and only the third needs a mechanism:

| scope | what is kept | lifetime |
|---|---|---|
| kept window (`keepRecentTokens`) | messages verbatim | ~one window of work |
| compacted region (one generation) | all user messages in it, as capped `user:` lines | one compaction cycle |
| **the pin** | the first user message only | forever, every compaction |

So a user directive already lives for roughly one full budget — verbatim in the
window, then emitted once in the next digest. That is why carrying *all* user
turns was rejected: it would duplicate the recency half and add unbounded state.
The pin is the complement of window+digest, not a duplicate of it: the window
handles recency, the digest one generation, and the origin is the one thing
neither can ever reach, because the stack only moves forward.

### Implementation

The task is stored in `details.task` and re-emitted into each new digest. It does
not accumulate: every compaction rebuilds the digest as `[pin] + [this region]`
and discards the previous summary rather than merging it, so there is one copy per
digest, forever.

Three cases, and the distinction between the last two is the important one:

| state | behaviour |
|---|---|
| a carried task exists | re-emit it, unchanged — never re-captured, so it cannot drift |
| no previous compaction (**the origin**) | capture the region's first user message; it is already in the body, so no head pin (that would duplicate) |
| previous compaction, no carried task (**broken chain**) | **no pin** — yield nothing rather than promote whichever user message leads this region |

The broken-chain case matters because an earlier version captured from the region
whenever nothing was carried, which silently relabelled a mid-session message as
the task — worse than no pin, because a wrong goal is more damaging than an absent
one. A chain break happens when the session moves to Pi's native compaction and
back, since Pi's own `details` is `{readFiles, modifiedFiles}` with no `task`.

### Two deliberate choices

**Capped by `humanMaxChars`, not a dedicated knob.** The pin is re-emitted in every
digest, so its cap is a recurring cost. In the measured 546k-token session the
first message was one sentence plus a large pasted log, so a tighter cap would
spend less. Reusing `humanMaxChars` was chosen so no part of a goal is ever
silently dropped; the measurement is in §12 if that trade needs revisiting.

**Labelled as provenance.** Emitted as `[original request]` above a normal
`user:` line rather than as a bare user message. The content is verbatim and capped
identically — only the framing differs. This is a small deviation from Algorithm 1,
which supplies `x` as an ordinary message. The reason is the one failure the pin
can cause: if the goal changes and the new directive ages out of both the window
and a digest generation, a bare line at the head reads as the standing goal and can
outweigh hundreds of steps of work that contradict it. Labelling it costs nothing
and makes it provenance instead of an instruction.

### Residual risk, stated plainly

Anchoring is reduced, not eliminated. The pin is still salient text at the head of
the summary. It is worth noting that the paper has the same exposure and no
mitigation: Algorithm 1 drops every user message except `messages[1]`, so a
mid-session change of goal loses the revision while the superseded goal stays
pinned. It never bites in their KernelBench setup, where the goal is stable for
400 steps.
