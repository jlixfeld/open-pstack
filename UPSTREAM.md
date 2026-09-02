# Upstream synchronization

open-pstack tracks [Cursor's pstack](https://github.com/cursor/plugins/tree/main/pstack) while adapting Cursor-specific primitives for Claude Code and Codex.

## Current sync point

| Source | Value |
| --- | --- |
| Repository | `https://github.com/cursor/plugins.git` |
| Path | `pstack/` |
| Commit | `bdf7aa355337897f167153e05069aca505dae17c` |
| Upstream version | `0.14.3` |
| open-pstack version | `1.2.3` |

The table above is the current Cursor sync point. Open Pstack 1.2.3 retains this 0.14.3 sync. `README-UPSTREAM.md` preserves its pstack README verbatim. `CHANGES.md` and `NOTICE.md` describe the adaptations and provenance.

## Monitor baseline facts

- The Eric port-upstream work started from `27e0ce32be3dfc496d1372a4f3d45d91d15007da`.
- The Cursor default-branch head observed at monitor start was `68836ddaf5697224520f1847d90cdb90ca8babaa`.
- The content-sync commit remains `bdf7aa355337897f167153e05069aca505dae17c`; observing the later Cursor head does **not** claim that it was backported.

The weekly monitor compares only `pstack/` and maintains one marker-owned GitHub issue when that tree drifts. See [upstream pstack monitoring](docs/upstream-pstack-monitoring.md) for the backport and port-maintenance contract.

## Check for changes

The repository names Cursor's repository as the `cursor-upstream` remote in the maintainer checkout. A fresh clone can add it once:

```shell
git remote add cursor-upstream https://github.com/cursor/plugins.git
```

Run the repeatable monitor from the repository root. It fetches the configured read-only remote and reports only `pstack/` drift:

```shell
plugins/pstack/skills/poteto-mode/scripts/upstream-pstack/pstack-upstream
```

The underlying manual inspection commands are:

```shell
git fetch cursor-upstream main
git log --oneline bdf7aa355337897f167153e05069aca505dae17c..cursor-upstream/main -- pstack
git diff --stat bdf7aa355337897f167153e05069aca505dae17c..cursor-upstream/main -- pstack
```

No output means the tracked pstack tree has not changed. This comparison does not need a polling service or generated mirror branch.

## Incorporate a change

1. Create or update a GitHub issue in `jlixfeld/open-pstack` and branch from current `main`.
2. Read each upstream pstack commit in order. Bring over its intent and content, then apply only the Claude Code and Codex substitutions documented in `CHANGES.md`.
3. Keep one shared `plugins/pstack/skills/` tree. Put harness translation in the existing `codex-tools.md` and provider routing in `provider-dispatch.md`; do not fork a skill per harness.
4. Update the commit and version in this file, the affected provenance rows in `NOTICE.md`, and `README-UPSTREAM.md` when upstream changes it.
5. Run CI-equivalent checks locally, then run the installed Claude Code and Codex behavioral lanes required by the changed surface. Unit tests alone are not a release gate.
6. Merge the reviewed PR before tagging the next open-pstack release.

## Pull from Eric's port

Keep direct port updates separate from Cursor backports:

```shell
git fetch port-upstream main
git switch -c port-upstream/<topic> main
git log --oneline main..port-upstream/main
```

Review the Eric commits, merge or cherry-pick the intended range on that branch, run the same repository and live-surface checks, and open a pull request against this fork. Do not update the Cursor content-sync commit unless the pull request independently verifies and incorporates the corresponding Lauren changes under `pstack/`.

Cursor's version and open-pstack's version are independent. Cursor's version identifies the imported content; open-pstack's version identifies the cross-harness distribution.
