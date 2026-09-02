# Tiered routing design

## Problem

The active model sheet stores exact role descriptors, but setup currently asks for one effort per mandatory model family. That flow cannot represent different Codex models or efforts per role. It also cannot preserve a selected effort for a family that no active role uses. Setup and rollback exist only as instructions, so tests cannot prove final-map probe planning, write rollback, or byte-identical reruns.

The fork also needs a repeatable report for changes under `cursor/plugins/pstack`. The report must not update source code or mix Lauren backports with Eric port updates.

## Usage

The operator runs `setup-pstack` from Claude Code or Codex. Setup loads the active map, applies named role edits, and shows every role and lane with its parent-specific route. It derives one probe for each distinct exact descriptor in that final map. Aliases do not produce probes. Setup asks for confirmation only after every probe passes.

The first-run role map is:

```text
feature implementation: codex:gpt-5.6-terra@high
refactoring implementation: codex:gpt-5.6-luna@high
bug-fix: codex:gpt-5.6-sol@max
perf-issue: codex:gpt-5.6-sol@max
hillclimb: codex:gpt-5.6-sol@max
judgment and prose: claude:claude-opus-5@xhigh
hardest tasks: claude:claude-fable-5-1@max
how explorer: codex:gpt-5.6-luna@medium
how explainer: claude:claude-opus-5@xhigh
how critics: codex:gpt-5.6-sol@max, claude:claude-fable-5-1@max
why investigators, synthesizer: inherit-parent
reflect tooling, judgment, divergent, synthesizer: inherit-parent
arena runners: codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh
arena cross-judge pool: codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh
swarm workers: codex:gpt-5.6-luna@high
architect runners: codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh
interrogate reviewers: codex:gpt-5.6-sol@max, claude:claude-fable-5-1@max
```

The local upstream command fetches `cursor/plugins` and reports changes between the recorded Cursor commit and the current default branch, restricted to `pstack/`. The weekly workflow runs the same comparison and reconciles one marker-owned issue in this fork.

## Shape

`provider-dispatch.md` remains the human and machine-readable routing manifest. Its capability table defines Fable, Sol, Terra, Luna, Grok, and Opus. Each row owns the provider, model, valid efforts, and optional Claude-native agent stem. Sol and Terra accept `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Luna accepts `low`, `medium`, `high`, `xhigh`, and `max`. The manifest does not require an active map to use every supported family.

The manifest also owns the ordered role registry and first-run lanes. A role has one of three shapes:

- A `single` role has exactly one lane.
- A `panel` launches every lane in stored order, including repeated descriptors.
- A `pool` preserves every lane in stored order while its workflow chooses one lane.

The active model sheet contains exact `<provider>:<model>@<effort>` descriptors, `inherit-parent`, or `auto`. It does not contain fallback tiers. A failed model never selects a different descriptor.

The setup implementation exposes a real two-phase boundary:

1. `prepare` parses the manifest and the current sheet, expands the legacy combined feature and refactoring row when unambiguous, applies named edits, validates role cardinality, renders both target byte arrays in memory, and derives the unique final-map probe plan.
2. The parent runs each probe with its native or external route, shows every role, lane, effort, and route, then asks for confirmation.
3. `commit` rechecks both target baselines. If either target changed after `prepare`, it aborts without writing. Otherwise it atomically replaces changed files, reads both back, and restores every original snapshot after any write or readback failure. A target that did not exist before the transaction is removed during rollback.

Claude descriptors are native under a Claude parent and external under a Codex parent. Codex descriptors are native under a Codex parent and external under a Claude parent. Grok is external under both parents. `inherit-parent` and `auto` always use the parent-native route. The route resolver has no fallback branch.

The upstream monitor has two pure decisions behind thin command adapters. The comparison classifies the recorded Cursor tree, the Cursor head tree, and mapped local blobs. It reports net-zero changes, diverged history, changed `pstack/` paths, and paths that overlap fork-specific files. The issue decision supports create, update, reopen, close, and no-op transitions for one stable marker. Multiple marker-owned issues fail closed.

## Module map

```text
plugins/pstack/skills/poteto-mode/scripts/
  routing/
    manifest.ts
    role-map.ts
    dispatch.ts
  setup/
    engine.ts
    integration.ts
    transaction.ts
    cli.ts
    pstack-setup
  upstream-pstack/
    compare.ts
    facts.ts
    git.ts
    github.ts
    issues.ts
    cli.ts
    pstack-upstream
```

`runner/` remains responsible for one already-resolved external lane. Workflow skills remain responsible for task policy, fan-out, and synthesis. The upstream monitor does not import the PR watcher.

## Synthesis decision

The Terra candidate is the base because it puts the role map at the center and keeps the implementation small enough for one reviewable change. The Sol candidate contributed the canonical Markdown manifest, family-specific `ultra` support, the `pool` role shape, the real prepare and commit boundary, the stale-baseline check, and blob-based issue reconciliation.

The design uses one short-lived private plan to bind preview, probes, and commit. It rejects long-lived proof bundles, a filesystem journal, crash-recovery state, and a broad branded wire taxonomy. Those mechanisms add a second subsystem without improving the requested probe-failure and rollback guarantees. Probe outputs and receipts remain evidence, not active setup state.

## Tradeoffs accepted

- We accept strict parsing of the routing tables in exchange for one routing authority that both documentation and code can use.
- We accept compensating rollback across two files because one rename cannot make two paths visible at the same instant.
- We accept one long-lived tracking issue so weekly runs update a stable record instead of creating issue noise.
- We accept a one-time legacy combined-role migration. Setup always renders separate feature and refactoring rows afterward.

## Verification contract

Tests must cover every supported family, invalid provider and model pairs, role cardinality, optional families, per-role efforts, exact probe planning, both parent route tables, ordered panels, pool behavior, failed-probe no-write behavior, stale baselines, rollback after each target write or readback, and unchanged byte-identical reruns.

Upstream tests must cover no changes, unrelated repository changes, `pstack/` changes, overlap classification, deterministic issue text, create, update, reopen, close, no-op, and duplicate marker failures.

The exact installed candidate must also pass the repository checks, the requested live model probes, and one mixed panel from each available parent.
