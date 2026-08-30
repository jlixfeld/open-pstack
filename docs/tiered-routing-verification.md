# Tiered routing verification

This record summarizes the live evidence for the tiered model routing candidate. Raw external-runner outputs and JSON receipts remain on the verification host under `/private/tmp/open-pstack-live/`. The summary omits session identifiers while preserving the selected descriptor, route evidence, elapsed time, token usage, and cost.

## Model probes

| Descriptor | Parent route | Result | Model evidence | Elapsed | Usage | Cost |
| --- | --- | --- | --- | ---: | --- | ---: |
| `codex:gpt-5.6-luna@medium` | Codex native | Pass | Exact assigned native task and marker | Not exposed | Not exposed | Not exposed |
| `codex:gpt-5.6-luna@high` | Codex native | Pass | Exact assigned native task and marker | Not exposed | Not exposed | Not exposed |
| `codex:gpt-5.6-terra@high` | Codex native | Pass | Exact assigned native task and marker | Not exposed | Not exposed | Not exposed |
| `codex:gpt-5.6-sol@max` | Codex native | Pass | Exact assigned native task and marker | Not exposed | Not exposed | Not exposed |
| `claude:claude-opus-5@xhigh` | Codex external | Pass | Provider reported `claude-opus-5` | 10,223 ms | input 4, cache read 30,140, cache create 27,139, output 513 | $0.300351 |

Fable and Grok were not probed because neither family appears in the initial active role map. No probe substituted a model or effort.

## Mixed-panel smoke tests

The Claude-parent panel loaded the candidate with `--plugin-dir`. Terra and Sol used the external Codex runner. Opus used the native Claude agent. The independent Sol judge returned `JUDGE_VERDICT: PASS`.

| Claude-parent lane | Route | Result | Elapsed | Usage | Cost |
| --- | --- | --- | ---: | --- | ---: |
| Terra high | External Codex | Pass | 10,278 ms | input 35,889, cache read 27,136, output 260, reasoning 123 | Not exposed |
| Sol max | External Codex | Pass | 12,763 ms | input 36,356, cache read 17,152, output 255, reasoning 102 | Not exposed |
| Opus xhigh | Native Claude | Pass | Not exposed per lane | Not exposed per lane | Not exposed per lane |
| Sol max judge | External Codex | Pass | 41,653 ms | input 83,238, cache read 58,624, output 1,518, reasoning 860 | Not exposed |

The successful Claude parent orchestration took 158,117 ms and reported $1.695355 aggregate cost. A later rerun after the final review fixes did not start a lane because Anthropic returned the account session limit. That dropout used no tokens or cost and did not trigger a fallback. The final fixes affect setup path canonicalization, tests, and documentation. They do not change the panel descriptors or parent route table. The repository gate still requires a successful exact-final-candidate Claude-parent rerun before the pull request can leave draft state.

The Codex-parent panel used native Terra and Sol tasks plus the external Opus runner. Its independent Opus judge returned `JUDGE_VERDICT: PASS`.

| Codex-parent lane | Route | Result | Elapsed | Usage | Cost |
| --- | --- | --- | ---: | --- | ---: |
| Terra high | Native Codex | Pass | Not exposed | Not exposed | Not exposed |
| Sol max | Native Codex | Pass | Not exposed | Not exposed | Not exposed |
| Opus xhigh | External Claude | Pass | 7,104 ms | input 4, cache read 30,809, cache create 27,907, output 290 | $0.302783 |
| Opus xhigh judge | External Claude | Pass | 27,481 ms | input 8, cache read 94,108, cache create 23,596, output 1,928 | $0.332478 |

After the final fixes, Codex installed version `1.2.0` from the fork checkout as the local `open-pstack` marketplace. The installed tree matches `plugins/pstack` byte for byte outside generated `node_modules` links. Post-install native Terra and Sol checks passed. A post-install external Opus check passed with provider-reported `claude-opus-5` in 53,196 ms, using input 14, cache read 236,938, cache create 43,471, and output 3,341 tokens at $0.637877.

## Review and verification

Sol and Opus ran independent adversarial reviews. Accepted findings covered nested-working-directory upstream comparison, family-specific runner validation, target snapshot races, rollback behavior, Claude include canonicalization, role-parser failure handling, workflow-consumer drift checks, and documentation accuracy. A proposed TypeScript rewrite of the Markdown schema was dismissed because the existing Markdown manifest remains the shared human-readable source and exact alignment tests now bind its consumers. Positional probe matching remains intentionally strict because accepting a reordered receipt set would weaken the exact final-map contract.

The final local gate passed:

- 209 Bun tests across 20 files with 810 assertions.
- Strict TypeScript checks for watch-pr, runner, routing, setup, upstream-pstack, and check-plan.
- Static skill and routing invariants.
- JSON parsing for both marketplace manifests and both plugin manifests.
- `git diff --check`.

The repository defines no lint script. The CI workflow runs the same tests, typecheck, manifest validation, and static invariant command.

## Upstream comparison

The recorded Cursor content commit is `bdf7aa355337897f167153e05069aca505dae17c`. The live comparison used Cursor head `68836ddaf5697224520f1847d90cdb90ca8babaa` and found three `pstack/` changes with no overlap against fork-specific files. The comparison also passed when launched from the nested scripts directory, proving the top-level pathspec behavior.
