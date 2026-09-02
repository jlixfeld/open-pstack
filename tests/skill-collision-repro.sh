#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

note() { printf '%s\n' "$*"; }

legacy_command_dir="$repo/plugins/pstack/commands"
if [ -e "$legacy_command_dir" ]; then
  note "FAIL: legacy command layer still exists: $legacy_command_dir"
  find "$legacy_command_dir" -mindepth 1 -print 2>/dev/null || true
  fail=1
else
  note "ok: native skills are the only user-facing workflow surface"
fi

bad_principle=""
for skill in "$repo"/plugins/pstack/skills/principle-*/SKILL.md; do
  if [ ! -f "$skill" ]; then
    bad_principle="no principle-* leaves found"$'\n'
    break
  fi
  front="$(sed -n '2,/^---$/p' "$skill")"
  printf '%s\n' "$front" | grep -q '^user-invocable: false$' || bad_principle="$bad_principle$skill (missing user-invocable: false)"$'\n'
  printf '%s\n' "$front" | grep -q '^disable-model-invocation: true$' && bad_principle="$bad_principle$skill (still carries disable-model-invocation)"$'\n'
done
if [ -n "$bad_principle" ]; then
  note "FAIL: principle-* leaves must be user-invocable: false and model-readable:"
  note "$bad_principle"
  fail=1
else
  note "ok: all principle-* leaves request user-hidden and remain model-readable"
fi

verof() { { grep -m1 '"version"' "$1" || true; } | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'; }
vc="$(verof "$repo/plugins/pstack/.claude-plugin/plugin.json")"
vx="$(verof "$repo/plugins/pstack/.codex-plugin/plugin.json")"
vm="$(verof "$repo/.claude-plugin/marketplace.json")"
vu="$(sed -n 's/| open-pstack version | `\([^`]*\)` |/\1/p' "$repo/UPSTREAM.md")"
if [ -n "$vc" ] && [ "$vc" = "$vx" ] && [ "$vc" = "$vm" ] && [ "$vc" = "$vu" ]; then
  note "ok: open-pstack version matches across UPSTREAM.md and the 3 manifests ($vc)"
else
  note "FAIL: open-pstack version differs: upstream=$vu claude-plugin=$vc codex-plugin=$vx marketplace=$vm"
  fail=1
fi

setup="$repo/plugins/pstack/skills/setup-pstack/SKILL.md"
dispatch="$repo/plugins/pstack/skills/poteto-mode/references/provider-dispatch.md"
route_bad=""
grep -Fq '| feature implementation | single | codex:gpt-5.6-terra@high |' "$dispatch" || route_bad="missing Terra feature role"$'\n'
grep -Fq '| refactoring implementation | single | codex:gpt-5.6-luna@high |' "$dispatch" || route_bad="missing Luna refactoring role"$'\n'
grep -Fq '| arena cross-judge pool | pool |' "$dispatch" || route_bad="cross-judge is not a pool"$'\n'
grep -Fq 'feature implementation: codex:gpt-5.6-terra@high' "$setup" || route_bad="setup misses split feature role"$'\n'
grep -Fq 'refactoring implementation: codex:gpt-5.6-luna@high' "$setup" || route_bad="setup misses split refactoring role"$'\n'
if [ -n "$route_bad" ]; then
  note "FAIL: the routing registry and setup example drifted:"
  note "$route_bad"
  fail=1
else
  note "ok: routing registry and setup example preserve the split roles and pool"
fi

monitor="$repo/.github/workflows/cursor-pstack-monitor.yml"
if grep -Fq 'ref: ${{ github.event.repository.default_branch }}' "$monitor"; then
  note "ok: manual upstream monitoring reconciles from the default branch"
else
  note "FAIL: upstream monitoring can reconcile repository issues from a non-default branch"
  fail=1
fi

plugin="$repo/plugins/pstack"
canon="$plugin/skills/poteto-mode/references/bugbot-triage.md"
skill="$plugin/skills/babysit/SKILL.md"
playbook="$plugin/skills/poteto-mode/playbooks/babysit.md"
bugbot_skill_rel="../poteto-mode/references/bugbot-triage.md"
bugbot_playbook_rel="../references/bugbot-triage.md"
bugbot_bad=""
if [ ! -f "$canon" ]; then
  bugbot_bad="${bugbot_bad}canonical rubric missing: $canon"$'\n'
fi
skill_op="$(grep -F 'Review-bot comments (Bugbot and similar automation):' "$skill" || true)"
skill_n="$(printf '%s\n' "$skill_op" | awk 'NF { c++ } END { print c+0 }')"
if [ "$skill_n" != "1" ]; then
  bugbot_bad="${bugbot_bad}standalone babysit skill lost bugbot-triage operational line"$'\n'
else
  skill_dest="$(printf '%s\n' "$skill_op" | sed -n 's/.*](\([^)]*\)).*/\1/p')"
  if [ "$skill_dest" != "$bugbot_skill_rel" ]; then
    bugbot_bad="${bugbot_bad}standalone babysit Markdown destination is [$skill_dest], not [$bugbot_skill_rel]"$'\n'
  fi
  if ! printf '%s\n' "$skill_op" | grep -Fq 'classify as fix, dismiss, or ask'; then
    bugbot_bad="${bugbot_bad}standalone babysit lost fix/dismiss/ask classification"$'\n'
  fi
  if ! printf '%s\n' "$skill_op" | grep -Fq "Follow the rubric's Ask by default categories, including security, data, and high-severity findings."; then
    bugbot_bad="${bugbot_bad}standalone babysit lost ask-by-default escalation"$'\n'
  fi
fi
playbook_op="$(grep -E '^8\. \*\*Bugbot is triaged skeptically, always\.\*\*' "$playbook" || true)"
playbook_n="$(printf '%s\n' "$playbook_op" | awk 'NF { c++ } END { print c+0 }')"
if [ "$playbook_n" != "1" ]; then
  bugbot_bad="${bugbot_bad}poteto-mode babysit playbook lost step-8 Bugbot operational line"$'\n'
elif ! printf '%s\n' "$playbook_op" | grep -Fq "$bugbot_playbook_rel"; then
  bugbot_bad="${bugbot_bad}poteto-mode babysit playbook step 8 lost bugbot-triage binding ($bugbot_playbook_rel)"$'\n'
fi
copies="$(find "$plugin" -name 'bugbot-triage.md' ! -path '*/node_modules/*' -print 2>/dev/null || true)"
n="$(printf '%s\n' "$copies" | awk 'NF { c++ } END { print c+0 }')"
if [ "$n" != "1" ]; then
  bugbot_bad="${bugbot_bad}expected exactly 1 bugbot-triage.md under plugin, found $n"$'\n'
fi
if [ -n "$bugbot_bad" ]; then
  note "FAIL: babysit Bugbot binding on the packaged plugin"
  note "$bugbot_bad"
  fail=1
else
  note "ok: babysit Bugbot binding on the packaged plugin"
fi

forge_files=(
  "$plugin/skills/poteto-mode/playbooks/autopilot-full.md"
  "$plugin/skills/poteto-mode/playbooks/autopilot-stack.md"
  "$plugin/skills/poteto-mode/playbooks/babysit.md"
  "$plugin/skills/poteto-mode/playbooks/multi-phase-plan.md"
  "$plugin/skills/poteto-mode/playbooks/opening-a-pr.md"
  "$plugin/skills/poteto-mode/playbooks/shipping.md"
)
forge_bad=""
for forge_file in "${forge_files[@]}"; do
  if ! grep -Fq 'Never require Graphite (`gt`).' "$forge_file" && ! grep -Fq 'Never require `gt`.' "$forge_file" && ! grep -Fq 'Do not require Graphite (`gt`).' "$forge_file"; then
    forge_bad="${forge_bad}${forge_file} does not make Graphite optional"$'\n'
  fi
  if ! grep -Fq 'command -v origin' "$forge_file"; then
    forge_bad="${forge_bad}${forge_file} does not resolve Origin before selecting the forge"$'\n'
  fi
done
for forge_file in "${forge_files[@]}"; do
  if grep -Eq 'gt (submit|restack|sync|track|merge)' "$forge_file"; then
    forge_bad="${forge_bad}${forge_file} still invokes Graphite"$'\n'
  fi
done
shipping="$plugin/skills/poteto-mode/playbooks/shipping.md"
for shipping_invariant in \
  'Prepare only the bottom PR.' \
  'Do not retarget, arm, or merge descendants yet.' \
  'verdict head SHA, base SHA, and stable `git patch-id`' \
  'Wait for that PR to merge before preparing the next one.' \
  'Recompute after every merge.' \
  'mergedAt` is non-null or `state` is `MERGED`'; do
  if ! grep -Fq "$shipping_invariant" "$shipping"; then
    forge_bad="${forge_bad}shipping lost invariant: $shipping_invariant"$'\n'
  fi
done
for stack_invariant in \
  'A stack is a base-branch chain.' \
  'Only the root PR targets trunk.'; do
  if ! grep -Fq "$stack_invariant" "$plugin/skills/poteto-mode/playbooks/opening-a-pr.md" "$plugin/skills/poteto-mode/playbooks/autopilot-stack.md"; then
    forge_bad="${forge_bad}base-branch stack invariant missing: $stack_invariant"$'\n'
  fi
done
if [ -n "$forge_bad" ]; then
  note "FAIL: forge-neutral PR lifecycle invariants"
  note "$forge_bad"
  fail=1
else
  note "ok: forge-neutral PR lifecycle keeps Graphite optional and waits for completed bottom-up merges"
fi

multi_phase="$plugin/skills/poteto-mode/playbooks/multi-phase-plan.md"
opening_pr="$plugin/skills/poteto-mode/playbooks/opening-a-pr.md"
stack_rebase_bad=""
for blanket_rebase in \
  'Rebase onto current trunk before babysit and again before the merge-ready report.' \
  'Rebased onto current trunk after the verdict, patch-id unchanged.'; do
  if grep -Fq "$blanket_rebase" "$multi_phase"; then
    stack_rebase_bad="${stack_rebase_bad}multi-phase plan still rebases every stacked PR onto trunk"$'\n'
  fi
done
if grep -Fq 'Rebase on trunk before substantial stack work.' "$opening_pr"; then
  stack_rebase_bad="${stack_rebase_bad}opening-a-pr still gives every stacked child a trunk rebase"$'\n'
fi
for stack_rebase_invariant in \
  'Rebase a root PR onto current trunk. Rebase a stack child onto its parent'\''s exact tip.' \
  'After any rewritten push, compare the base-to-head patch-id and rerun mergeability and CI.' \
  'Rebase root PRs on trunk. Rebase child PRs on their parent'\''s exact tip. For an existing chain, rebase it bottom-to-top.'; do
  if ! grep -Fq "$stack_rebase_invariant" "$multi_phase" "$opening_pr"; then
    stack_rebase_bad="${stack_rebase_bad}missing stack rebase invariant: $stack_rebase_invariant"$'\n'
  fi
done
if [ -n "$stack_rebase_bad" ]; then
  note "FAIL: stacked PR rebases preserve parent bases"
  note "$stack_rebase_bad"
  fail=1
else
  note "ok: root and child PRs rebase onto their correct bases with patch-id and CI rechecks"
fi

if [ "${PSTACK_STATIC_ONLY:-0}" = "1" ]; then
  exit "$fail"
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/.claude-plugin" "$scratch/skills/foo"
printf '%s\n' '{"name": "testplug", "version": "0.0.1", "description": "native skill repro"}' \
  > "$scratch/.claude-plugin/plugin.json"
cat > "$scratch/skills/foo/SKILL.md" <<'EOF'
---
name: foo
description: collision test skill
---

Say exactly: SKILL-RAN
Then stop. Do not invoke any skill or tool.
EOF

run() {
  claude -p --plugin-dir "$scratch" --model claude-fable-5-1 --effort max --max-turns 3 "$1" < /dev/null 2>&1
}

check() { # $1 label, $2 expected marker, $3 output
  if printf '%s' "$3" | grep -q "$2"; then
    note "ok: $1 -> $2"
  else
    note "FAIL: $1 expected $2, got: $3"
    fail=1
  fi
}

invoke='Call the Skill tool with skill "testplug:foo" exactly once and follow what it says.'

check "model-initiated Skill-tool invocation" "SKILL-RAN" "$(run "$invoke")"
check "user /testplug:foo invocation" "SKILL-RAN" "$(run '/testplug:foo')"

exit "$fail"
