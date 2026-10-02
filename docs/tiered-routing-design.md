# Personal model routing design

## Contract

PStack defines workflow roles and their shapes. The current harness's personal sheet supplies every model, effort, and alias assignment. Claude Code reads `~/.claude/pstack-models.md`; Codex reads `~/.codex/pstack-models.md`. Those paths are outside the plugin installation, so an update cannot regenerate their choices.

The shared [`provider-dispatch.md`](../plugins/pstack/skills/poteto-mode/references/provider-dispatch.md) registry carries a role name and one shape per row. A `single` role has exactly one lane. A `panel` launches every ordered lane, including repeats. A `pool` preserves ordered alternatives while its workflow selects one. The registry contains no first-run descriptors, model families, or default efforts.

Every workflow reads its named role from the current harness's sheet before launch. A missing sheet, missing role, malformed descriptor, or wrong lane count is a hard error. Setup also requires every registry role before committing a sheet. On a new installation or after an upgrade adds a role, the operator assigns each missing role explicitly. `inherit-parent` and `auto` work only when written in the sheet. There is no injected alias, cross-harness search, or model fallback.

## Setup transaction

`pstack-setup prepare` parses existing rows and named edits, validates role identity and cardinality, and renders the complete proposed sheet and harness integration in memory. It expands a legacy `feature, refactoring` row into the two named roles without changing either lane. It rejects duplicate or unknown roles, malformed rows, and remaining missing roles. A named edit may replace a syntactically valid obsolete selection. Existing assignments, ordered lanes, and repeats stay intact.

Setup probes each distinct concrete `<provider>:<model>@<effort>` selection on its resolved route. A probe must use the exact model and effort. A failed or unavailable selection stops the transaction; no model or effort is substituted. Explicit aliases are native and add no descriptor probe. The external runner validates safe route syntax, then sends the exact selection to the provider CLI. Its production code contains no model-name catalog.

After the operator reviews the exact route preview and probe results, `pstack-setup commit` checks that the manifest and both targets still match the prepared hashes. It writes only changed targets, verifies readback, and rolls back a failed write. A byte-identical rerun makes no active writes. Claude integration is one `@` include in `CLAUDE.md`; Codex integration is an exact bounded mirror in `AGENTS.md`. Setup rejects symlinks and malformed markers, and preserves unrelated instruction text.

## Dispatch and verification

The parent harness resolves every route once. Claude descriptors are native under Claude, and Codex descriptors are native under Codex. Cross-provider descriptors use the external runner. A child cannot change its assigned route. An unavailable model or CLI produces a named failure. The parent does not retry with a different model.

Tests cover fresh and partial sheets, explicit edits, legacy row expansion, exact route and probe plans, panel order and repeats, pool shape, missing and malformed selections, failed probes, stale baselines, rollback, and idempotent reruns. The exact installed candidate still needs the live Claude Code and Codex behavioral checks required by [`AGENTS.md`](../AGENTS.md) before release.

The upstream monitor is separate from this routing contract. It compares the recorded Cursor `pstack/` tree with the current upstream tree and reconciles one marker-owned issue when they differ.
