# Upstream pstack monitoring

`pstack-upstream` compares the `Commit` in `UPSTREAM.md` with Cursor's current default branch. It fetches `cursor-upstream/main` when no `--upstream-ref` is supplied, or accepts a caller-fetched ref for CI. The comparison is restricted to `pstack/`; commits elsewhere in `cursor/plugins` are not drift.

Run it from the repository root:

```shell
plugins/pstack/skills/poteto-mode/scripts/upstream-pstack/pstack-upstream
```

The report prints the old and new full SHA, a Cursor comparison URL, changed `pstack/` paths, and overlaps supported by blob evidence. Shared paths map to `plugins/pstack/<relative>`; `pstack/README.md` maps to `README-UPSTREAM.md`; `.cursor-plugin/` and `.cursor/` paths are classified as Cursor-only metadata. An overlap exists only when the local `HEAD` blob differs from the recorded Cursor-base blob. A rename reports both its old and new path. The command is read-only until `--repo owner/repository` requests issue reconciliation.

The weekly workflow fetches Cursor read-only and reconciles one issue identified by a stable hidden marker. It fails closed if more than one issue owns that marker. When `pstack/` drifts, it creates, updates, or reopens that issue; after the recorded content-sync commit catches up, it closes the issue. It never updates the recorded commit or backports source content.

Each Lauren backport gets its own branch and pull request. Advance the recorded content-sync commit only after the backport's required repository and live-surface verification succeeds. Preserve the existing fork adaptations and the tiered-routing design during every backport.

Pull Eric port changes separately. Fetch `port-upstream`, create a branch from the fork's current `main`, and merge or cherry-pick only the reviewed Eric commits there. Open that branch as its own pull request against the fork. Do not combine a `port-upstream` update with a Lauren backport or advance the recorded Cursor commit merely because Eric's branch moved.
