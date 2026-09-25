# pi-cliffcompaction

CliffCompaction for [Pi](https://github.com/earendil-works/pi): a mechanical,
truncate-only compaction strategy that replaces Pi's LLM summariser.

Pi already implements cliff's *mechanism* — a summary followed by a verbatim
recent tail, cut at a token threshold, never cutting a tool result. The only
non-cliff part is the summary, which Pi generates by asking an LLM to merge the
previous summary into a new one. That is the summary-of-summaries chain
CliffCompaction exists to avoid.

So this extension replaces the summary generator and nothing else: at
`session_before_compact` it returns a digest built by truncating and dropping
content by class, never by rephrasing it. No auxiliary LLM call, and no
compaction ever folds a prior compaction forward.

See [DESIGN.md](DESIGN.md) for the rationale, the deviations from the paper, and
the measurements behind the defaults.

## Status

Early. The policy core and its tests are in place; the Pi adapter, the
configuration menu, and the threshold write-back are next. See DESIGN.md §10–11.

## Layout

```
src/types.ts       structural mirror of the AgentMessage subset we touch
src/policy.ts      tool-aware retention classes (drop / excerpt / keep)
src/serialize.ts   the algorithm: compacted region -> mechanical digest
src/config.ts      defaults, merge, and threshold <-> reserveTokens arithmetic
```

## Development

Node 22+ runs TypeScript directly, so tests need no build step and no test
framework:

```bash
npm install
npm test        # node --test
npm run typecheck
```

## Configuration

Knobs live in `~/.pi/agent/cliffcompaction.json`, with an optional project-level
`<project>/.pi/cliffcompaction.json` taking precedence. Defaults:

| Knob | Default | Meaning |
|---|---|---|
| `thresholdTokens` | 250000 | peak context at which compaction fires (realised as Pi's `reserveTokens`) |
| `reserveFloor` | 16384 | response headroom; a normal-turn allowance, not the model's max output |
| `keepRecentTokens` | 40000 | verbatim window kept after a cliff |
| `recentMode` | `tokens-snapped` | whole turns only; `tokens` = Pi's splitting cut, `turns` = paper Algorithm 1 |
| `maxTurnOvershoot` | 20000 | overshoot accepted before falling back to a split cut |
| `resultMaxChars` | 500 | tool results longer than this are dropped or excerpted |
| `cmdMaxChars` | 150 | tool-call signature cap |
| `thinkingMode` | `keep` | or `drop` |
| `thinkingMaxChars` | 2000 | per assistant message; 0 = unlimited |
| `thoughtMaxChars` | 0 | visible assistant text; 0 = unlimited |
| `humanMaxChars` | 20000 | per user message |
| `excerptHead` / `excerptTail` | 300 / 200 | for results that cannot be regenerated |
| `dropTools` | `read, grep, find, ls` | re-runnable — safe to drop |
| `excerptTools` | `bash, powershell, edit, write` | side-effecting — never dropped silently |
| `alwaysKeepErrors` | `true` | error results are never dropped |
| `honorManualInstructions` | `true` | `/compact <instructions>` falls through to Pi's LLM summariser |
| `shadow` | `true` | compute and report, modify nothing |

The threshold is the one value that lives in Pi's own config, because Pi owns the
trigger. It is applied as
`reserveTokens = max(reserveFloor, contextWindow − thresholdTokens)` — per model,
via `compaction.modelOverrides`.
