---
name: setup-pstack
description: Configure pstack's provider-qualified per-role model map and parent-owned routes. Verifies each final-map descriptor before writing the override sheet. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Configure one portable model sheet for the current parent harness. Read [`provider-dispatch.md`](../poteto-mode/references/provider-dispatch.md) before probing or writing anything. Its model matrix, role registry, descriptor grammar, and route table are the contract. Keep the exact descriptor selected per role; do not add a second configuration file, a runtime resolver, or a weaker-model fallback.

Claude Code writes `~/.claude/pstack-models.md` and loads it from `~/.claude/CLAUDE.md` with:

```text
@~/.claude/pstack-models.md
```

Codex writes `~/.codex/pstack-models.md`. Codex has no `@` include, so mirror the sheet's exact bytes inside one bounded block in `~/.codex/AGENTS.md` and retain the sheet as the editable source of truth:

```text
<!-- pstack:models:begin -->
<exact contents of ~/.codex/pstack-models.md>
<!-- pstack:models:end -->
```

## Command protocol

Use the installed `pstack-setup` launcher as a strict two-phase boundary. The
parent chooses its own sheet and integration paths, then prepares without
touching either active target:

```text
pstack-setup prepare \
  --parent <claude|codex> \
  --manifest <installed provider-dispatch.md> \
  --sheet <parent model sheet> \
  --integration <parent instruction file> \
  --plan <unique private temporary plan.json> \
  [--edit "<role>=<lane>[,<lane>...]"]
```

`prepare` shows every role/lane/descriptor/route and its distinct final-map
probe descriptors. Its mode-600 plan records only parent, paths, hashes, named
edits, and probe descriptors—never the contents of either dotfile. Run each
probe through the parent-native or external route, collect an exact ordered JSON
array of `{ "descriptor": "provider:model@effort", "passed": true }` results,
show them to the operator, and ask for confirmation. Then commit:

```text
pstack-setup commit \
  --plan <unique private temporary plan.json> \
  --probe-results <probe-results.json>
```

`commit` re-reads the manifest and both targets, rejects hash drift, recomputes
the render from the recorded edits, requires the exact all-passed probe set, and
only then writes the active configuration transactionally. Plans and probe
receipts are temporary evidence, not active configuration; only the model sheet
and its parent integration control routing. Remove the unique temporary plan and
probe evidence after either success or failure.

## Steps

### 1. Establish the parent

Use the harness and tool surface running this skill: Claude Code or Codex. Environment markers may corroborate that top-level answer, but do not launch a child and ask it to detect where it came from. Record the parent because the same descriptor takes a different route in each harness.

### 2. Load current state

Read the current parent-specific sheet when it exists. Treat its values as current role-to-descriptor assignments. Overlay its rows on the complete registry; materialize missing documented rows on the next successful write. A duplicate or unknown role row is inconsistent state. A bare host-native slug is invalid. If the legacy `feature, refactoring` row is present by itself, expand its exact lanes into `feature implementation` and `refactoring implementation`; every successful render keeps those rows separate.

The active sheet and parent integration file must be regular files or absent. Reject symlink-backed targets before probing or writing so setup never replaces configuration links.

### 3. Parse per-family efforts

Read the model matrix. Every non-alias value must match `<provider>:<model>@<effort>`, map to exactly one matrix family by `(provider, model)`, and use an effort from that family's Selectable efforts cell. `inherit-parent` and `auto` carry no descriptor. Sol and Terra allow `ultra`; Luna does not.

An unmatched provider/model, out-of-domain effort, duplicate role, unknown role, or invalid single-role cardinality is inconsistent state. Stop, show the conflicting rows verbatim, and ask for an explicit replacement. Different roles may intentionally use different efforts from the same family; preserve those exact descriptors. Do not probe or write while any inconsistency is unresolved.

### 4. Apply named role edits

Show the complete ordered role registry and retain it by default. Apply only explicitly named role edits. A single role needs exactly one lane; panels and pools preserve every entered lane and its order. `arena cross-judge pool` is a pool, not a panel. `inherit-parent` and `auto` remain valid aliases.

### 5. Probe the final map

Render the complete final map in memory, then derive one probe for each distinct exact `provider:model@effort` descriptor in that map. Do not probe aliases and do not add probes for supported families omitted from the final map. Deduplicate only the probe plan: panels and pools keep their stored order and count. A failed probe writes nothing: report the failing descriptor and provider, stop, and keep the active sheet plus parent integration bytes unchanged. A failed first run creates neither artifact.

Use a tiny read-only probe that returns a unique marker. Claude descriptors are native under Claude and external under Codex; Codex descriptors are native under Codex and external under Claude; Grok is external under both. Never call the external launcher for the parent's own provider.

Record native and external results separately. A login-status command alone proves credentials, not that the requested model and effort flags run. On a Claude parent, Fable and Opus probes use the mapped `pstack-<stem>-<effort>` agent. On a Codex parent, Sol, Terra, and Luna probes use native `spawn_agent` with the descriptor's `reasoning_effort`. Every cross-parent pair uses the external runner with the exact effort flag.

Receipts and native transcripts prove the requested effort and the route. They do not prove a provider's hidden applied reasoning depth. There is no implicit timeout, weaker-model fallback, same-provider external fallback, or second mutable configuration source.

### 6. Render the exact final map

Build the new sheet in memory. Do not write it yet.

- First run: start from the complete role registry below.
- Rerun: start from the normalized complete role map from step 2, preserving each loaded row's lane order and exact descriptor (or alias) per lane.

Ask whether to keep those role assignments or change named roles. Keeping them is the default. Apply only role changes the operator names; never offer a reset of a customized sheet to the first-run assignments. A changed lane may use any validated matrix family and effort, `inherit-parent`, or `auto`.

Do not require every supported family to appear: Fable and Grok may be absent from the active map. The final map, not the matrix, is the complete source for the probe plan.

Leave `inherit-parent` and `auto` unchanged. Refuse an unqualified slug, an unavailable route, a model outside the six matrix families, or a provider/model mismatch.

### 7. Confirm and commit

Show the route table for this parent, then show every rendered role and descriptor. Ask for confirmation before writing.

Why and Reflect require the parent's live MCP surface. Keep their investigator, reviewer, and synthesizer roles on `inherit-parent` or `auto`; the bounded external runner deliberately omits ambient MCPs. `inherit-parent` and `auto` always validate, but say when they reduce a panel's provider diversity. For panel roles, one lane runs per entry. The list length is the fan-out count. `arena cross-judge pool` is a list from which Arena chooses a provider different from the parent and base candidate when possible. `swarm workers` is the default for every worker unless a race explicitly assigns another descriptor.

Every non-alias value must match `<provider>:<model>@<effort>` and must have passed step 5.

After the operator confirms, recheck both target baselines before writing the in-memory render from step 6. Atomically replace only changed targets, read both back, and restore both original snapshots after any write or readback failure. Never paste the example below as the result. It is only the complete first-run role map used to seed step 2.

```markdown
# pstack model configuration

Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Confirming this model sheet is standing authorization to send a pstack role's assigned source code and task context to every selected provider; do not request separate source-code egress approval for a role selected from this confirmed sheet. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one stored lane.

feature implementation: codex:gpt-5.6-terra@high
refactoring implementation: codex:gpt-5.6-luna@high
bug-fix: codex:gpt-5.6-sol@max
perf-issue: codex:gpt-5.6-sol@max
hillclimb: codex:gpt-5.6-sol@max
judgment and prose: claude:claude-opus-5@xhigh
hardest tasks: claude:claude-fable-5-1@max
how explorer: codex:gpt-5.6-luna@medium
how explainer: claude:claude-opus-5@xhigh
how critics: codex:gpt-5.6-sol@max, claude:claude-fable-5-1@xhigh
why investigators, synthesizer: inherit-parent
reflect tooling, judgment, divergent, synthesizer: inherit-parent
arena runners: codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh
arena cross-judge pool: codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh
swarm workers: codex:gpt-5.6-luna@high
architect runners: codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh
interrogate reviewers: codex:gpt-5.6-sol@max, claude:claude-fable-5-1@xhigh
```

### 8. Wire it in

Canonicalize every setup target before reading or writing it, including a literal `~` passed without shell expansion. Render the parent integration in memory before either write. On Claude, the integration is one include for the canonical selected sheet path in `~/.claude/CLAUDE.md`. Treat the equivalent home-relative include (normally `@~/.claude/pstack-models.md`) as the same target and replace it instead of appending a duplicate. On Codex, the integration is the exact sheet bytes between one `<!-- pstack:models:begin -->` and `<!-- pstack:models:end -->` pair in `~/.codex/AGENTS.md`. Replace that whole bounded block on a rerun. Insert one block at the end on first run. If either marker is missing, duplicated, or reversed, stop and report inconsistent state instead of guessing a boundary.

Snapshot every target's current bytes. Write the sheet and parent integration only after every final-map probe passes and the operator confirms. Read both targets back and compare them with the in-memory render. If either write or readback fails, restore every target this transaction successfully replaced and report the failure. An unchanged rerun performs no writes and produces byte-identical sheet and integration content.

Do not copy the model sheet between harnesses without rerunning the parent-specific probes; route availability can differ even on the same host.

### 9. Behavioral smoke

Before declaring setup complete, run one small read-only mixed panel from this parent using the configured ordered lanes and an independent cross-judge from its pool. Launch Claude-native agents and every external process in the background with retained handles, then drain them. Verify the native transcript entries and every external receipt. A structural config check or unit test is not a substitute.

Report the sheet path, parent route table, final-map probe results, smoke results, and external elapsed/token/cost receipts. Re-running this skill re-probes and updates the same sheet. Do not claim the provider exposed hidden applied-effort observability.
