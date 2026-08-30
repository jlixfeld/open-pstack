# Tiered routing verification

This record summarizes the live evidence for the tiered model routing candidate. Raw external-runner outputs and JSON receipts remain on the verification host under `/private/tmp/open-pstack-live/`. The summary omits session identifiers while preserving the selected descriptor, route evidence, elapsed time, token usage, and cost.

## Model probes

| Descriptor | Parent route | Result | Model evidence | Elapsed | Usage | Cost |
| --- | --- | --- | --- | ---: | --- | ---: |
| `codex:gpt-5.6-luna@medium` | Codex native | Pass | Exact assigned native task and marker | Not exposed | Not exposed | Not exposed |
| `codex:gpt-5.6-luna@high` | Codex native | Pass | Exact assigned native task and marker | Not exposed | Not exposed | Not exposed |
| `codex:gpt-5.6-terra@high` | Codex native | Pass | Exact assigned native task and marker | Not exposed | Not exposed | Not exposed |
| `codex:gpt-5.6-sol@max` | Codex native | Pass | Exact assigned native task and marker | Not exposed | Not exposed | Not exposed |
| `claude:claude-opus-5@xhigh` | Codex external | Pass | Provider reported `claude-opus-5` | 6,374 ms | input 4, cache read 30,143, cache create 27,243, output 294 | $0.295938 |

Fable and Grok were not probed because neither family appears in the initial active role map. No probe substituted a model or effort.

## Mixed-panel smoke tests

### Current one-per-provider panels

Commit `032abcc4076e1ed8629a4d1ffbb766fefce097b1` uses one model per active provider for Arena and Architect. Sol represents OpenAI and Opus represents Anthropic. Terra remains the feature-implementation model.

| Codex-parent lane | Route | Result | Elapsed | Usage | Cost |
| --- | --- | --- | ---: | --- | ---: |
| Sol max | Native Codex | Pass | Not exposed | Not exposed | Not exposed |
| Opus xhigh | External Claude | Pass | 113,669 ms | input 24, cache read 430,962, cache create 51,677, output 8,099 | $0.936045 |
| Sol max judge | Native Codex | Pass | Not exposed | Not exposed | Not exposed |

The installed Codex plugin matched the candidate tree outside generated dependency links. Both candidate lanes returned `arena=sol,opus`, `architect=sol,opus`, and `terra=feature-only`. The independent judge passed.

| Claude-parent lane | Route | Result | Elapsed | Usage | Cost |
| --- | --- | --- | ---: | --- | ---: |
| Sol max | External Codex | Pass | 57,330 ms | input 78,347, cache read 55,552, output 2,715, reasoning 1,246 | Not exposed |
| Opus xhigh | Native Claude | Pass | 48,188 ms | 40,185 total subagent tokens | Not exposed per lane |
| Sol max judge | External Codex | Pass | 88,336 ms | input 74,027, cache read 43,520, output 4,356, reasoning 2,290 | Not exposed |

The Claude parent loaded the exact candidate with `--plugin-dir`. Its 332,277 ms orchestration cost $2.128313. The parent drained the retained judge process until its receipt said `complete`, and the judge returned `JUDGE_VERDICT: PASS`. No third candidate, duplicate provider, substitution, or dropout occurred.

Two earlier attempts remained loud failures. Commit `47e5e2e` exposed stale three-lane prose in `docs/reference.md` and returned before its judge completed, so the runner recorded the judge as cancelled. Commit `7ea9ac2` exposed a second stale reference in the same file. Both references now have registry-bound regression assertions. No failed run triggered a fallback.

### Superseded three-lane panels

The following runs verified the earlier Terra, Sol, and Opus panel before the one-model-per-provider refinement.

The Claude-parent panel loaded the candidate with `--plugin-dir`. Terra and Sol used the external Codex runner. Opus used the native Claude agent. The independent Sol judge returned `JUDGE_VERDICT: PASS`.

| Claude-parent lane | Route | Result | Elapsed | Usage | Cost |
| --- | --- | --- | ---: | --- | ---: |
| Terra high | External Codex | Pass | 9,332 ms | input 38,378, cache read 17,152, output 234, reasoning 85 | Not exposed |
| Sol max | External Codex | Pass | 13,708 ms | input 38,484, cache read 17,152, output 433, reasoning 276 | Not exposed |
| Opus xhigh | Native Claude | Pass | 4,150 ms | 33,815 total subagent tokens | Not exposed per lane |
| Sol max judge | External Codex | Pass | 28,406 ms | input 40,097, cache read 27,136, output 1,040, reasoning 572 | Not exposed |

The earlier Claude-parent orchestration loaded commit `002a881a366c6b058e6de28bee69935e04a75582`, took 200,913 ms, and reported $1.906730 aggregate cost. All three lanes returned in configured order, the independent judge passed, and no lane dropped out or substituted a model.

The Codex-parent panel used native Terra and Sol tasks plus the external Opus runner. Its independent Opus judge returned `JUDGE_VERDICT: PASS`.

| Codex-parent lane | Route | Result | Elapsed | Usage | Cost |
| --- | --- | --- | ---: | --- | ---: |
| Terra high | Native Codex | Pass | Not exposed | Not exposed | Not exposed |
| Sol max | Native Codex | Pass | Not exposed | Not exposed | Not exposed |
| Opus xhigh | External Claude | Pass | 7,104 ms | input 4, cache read 30,809, cache create 27,907, output 290 | $0.302783 |
| Opus xhigh judge | External Claude | Pass | 27,481 ms | input 8, cache read 94,108, cache create 23,596, output 1,928 | $0.332478 |

After the final fixes, Codex installed version `1.2.0` from the fork checkout as the local `open-pstack` marketplace. The installed tree matches `plugins/pstack` byte for byte outside generated `node_modules` links. Post-install native Terra and Sol checks passed. A post-install external Opus check passed with provider-reported `claude-opus-5` in 53,196 ms, using input 14, cache read 236,938, cache create 43,471, and output 3,341 tokens at $0.637877.

## Review and verification

Sol and Opus ran independent adversarial reviews. Accepted findings covered nested-working-directory upstream comparison, family-specific runner validation, target snapshot races, rollback behavior, Claude include canonicalization, role-parser failure handling, workflow-consumer drift checks, and documentation accuracy. The final Opus xhigh rereview passed all four previously open areas against commit `002a881a366c6b058e6de28bee69935e04a75582` in 400,187 ms with provider-reported `claude-opus-5`, 28,785 output tokens, and $3.209149 cost. A proposed TypeScript rewrite of the Markdown schema was dismissed because the existing Markdown manifest remains the shared human-readable source and exact alignment tests now bind its consumers. Positional probe matching remains intentionally strict because accepting a reordered receipt set would weaken the exact final-map contract.

The final local gate passed:

- 209 Bun tests across 20 files with 814 assertions.
- Strict TypeScript checks for watch-pr, runner, routing, setup, upstream-pstack, and check-plan.
- Static skill and routing invariants.
- JSON parsing for both marketplace manifests and both plugin manifests.
- `git diff --check`.

The repository defines no lint script. The CI workflow runs the same tests, typecheck, manifest validation, and static invariant command.

## Upstream comparison

The recorded Cursor content commit is `bdf7aa355337897f167153e05069aca505dae17c`. The live comparison used Cursor head `68836ddaf5697224520f1847d90cdb90ca8babaa` and found three `pstack/` changes with no overlap against fork-specific files. The comparison also passed when launched from the nested scripts directory, proving the top-level pathspec behavior.
