#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

for fixture in hook policy; do
  copy="$scratch/$fixture"
  cp -R "$repo" "$copy"
  if [ "$fixture" = hook ]; then
    target="$copy/plugins/pstack/skills/tdd/SKILL.md"
    pattern='changed-branch-coverage\.md'
  else
    target="$copy/plugins/pstack/skills/principle-prove-it-works/references/changed-branch-coverage.md"
    pattern='coveredChangedBranches'
  fi
  awk -v pattern="$pattern" '$0 !~ pattern' "$target" > "$target.next"
  mv "$target.next" "$target"
  if PSTACK_STATIC_ONLY=1 "$copy/tests/skill-collision-repro.sh" >/dev/null 2>&1; then
    printf 'expected the static invariant to reject a broken coverage %s\n' "$fixture" >&2
    exit 1
  fi
done

printf '%s\n' 'ok: static invariant rejects broken coverage hooks and policy fields'
