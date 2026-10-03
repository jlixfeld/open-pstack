---
name: setup-pstack
description: Configure the current harness's personal pstack role-to-model map. Probe exact selections before writing the sheet.
---

# Setup pstack

Read [`provider-dispatch.md`](../poteto-mode/references/provider-dispatch.md). Its role registry defines required names and shapes. Only the current harness's personal sheet supplies model and effort assignments. Do not infer a model, effort, or alias from the plugin, another harness, or an absent row.

Claude Code uses `~/.claude/agent-model-map.md` and includes it from `~/.claude/CLAUDE.md` with `@~/.claude/agent-model-map.md`. Codex uses `~/.codex/agent-model-map.md` and mirrors its exact bytes between `<!-- agent:model-map:begin -->` and `<!-- agent:model-map:end -->` in `~/.codex/AGENTS.md`. These paths are outside the plugin installation and survive plugin updates. Do not copy a sheet between harnesses without probing from the destination parent.

## Configure

1. Identify the current parent harness. Read its personal sheet when present. Reject symlink-backed targets, duplicate or unknown roles, malformed descriptors, invalid lane counts, and broken integration markers. Expand a legacy `feature, refactoring` row into the two named roles without changing its lanes. Never overwrite an existing personal file with an example.
2. Compare the parsed rows with every name in the role registry. Ask the operator to assign each missing role explicitly. This includes a fresh installation and roles added by a plugin upgrade. Offer no first-run values. `inherit-parent` and `auto` are permitted only when the operator chooses them. Keep existing rows and ordered repeated lanes. A `single` role needs one lane; panels and pools need at least one.
3. Accept exact `<provider>:<model>@<effort>` descriptors. The provider is `claude`, `codex`, or `grok`; effort is `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. Syntax alone does not prove availability. Keep each selected effort; there is no global budget rewrite or implicit effort change.
4. Prepare the complete proposed map without touching active targets:

   ```text
   pstack-setup prepare \
     --parent <claude|codex> \
     --manifest <installed provider-dispatch.md> \
     --map <current parent agent model map> \
     --integration <current parent instruction file> \
     --plan <unique private temporary plan.json> \
     [--edit "<role>=<lane>[,<lane>...]"]...
   ```

   A missing role produces an error naming every role that needs an explicit edit. Re-run `prepare` with those edits. A role edit can replace an obsolete selection, but it cannot hide a duplicate, unknown role, malformed row, or another missing role. The preview shows every ordered lane and native or external route.
5. Probe every distinct concrete descriptor in the final map through its resolved route from this parent. A native probe must exercise the exact model and effort controls; an external probe uses `pstack-runner` in read-only mode. Check CLI availability and authentication where applicable. Reject any unsupported or unavailable selection. Aliases use the parent natively and do not add a descriptor probe. Do not substitute another model or route after a failure. Keep probe results as an ordered JSON array of `{ "descriptor": "provider:model@effort", "passed": true }`.
6. Show the complete sheet, route preview, and probe results. Ask for confirmation, then commit:

   ```text
   pstack-setup commit \
     --plan <unique private temporary plan.json> \
     --probe-results <probe-results.json>
   ```

   Commit rechecks the manifest and target hashes, recomputes the exact map, requires every probe to pass, and writes only changed files transactionally. It rolls back failed writes or readbacks. Keep unrelated instruction content. An unchanged rerun writes nothing. Remove temporary plan and probe evidence after success or failure.
7. Run a small read-only smoke from the installed parent using configured panel lanes in their stored order and a judge from its configured pool. Report the sheet path, exact routes, probe results, and smoke outcome. Do not claim a live surface was tested when it was not.

The personal sheet is the complete routing source. A workflow calls `pstack-setup resolve` for its named role and stops before launch when the sheet, role, descriptor, or route is missing or invalid. The parent resolves routes once; children do not reroute themselves.
