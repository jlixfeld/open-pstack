#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
copy="$scratch/candidate"
cp -R "$repo" "$copy"
PSTACK_STATIC_ONLY=1 "$copy/tests/skill-collision-repro.sh" >/dev/null

for target in AGENTS.md UPSTREAM.md .github/pull_request_template.md plugins/pstack/skills/poteto-mode/playbooks/opening-a-pr.md; do
  file="$copy/$target"
  cp "$file" "$scratch/original"
  sed 's/active deployment target/unsupported target/g' "$file" > "$scratch/mutated"
  cp "$scratch/mutated" "$file"
  if PSTACK_STATIC_ONLY=1 "$copy/tests/skill-collision-repro.sh" >/dev/null 2>&1; then
    printf 'FAIL: missing active-target gate accepted in %s\n' "$target" >&2
    exit 1
  fi
  cp "$scratch/original" "$file"
done

for target in AGENTS.md UPSTREAM.md plugins/pstack/skills/poteto-mode/playbooks/opening-a-pr.md; do
  file="$copy/$target"
  cp "$file" "$scratch/original"
  sed 's/not tested/verified/g' "$file" > "$scratch/mutated"
  cp "$scratch/mutated" "$file"
  if PSTACK_STATIC_ONLY=1 "$copy/tests/skill-collision-repro.sh" >/dev/null 2>&1; then
    printf 'FAIL: missing unused-runtime limitation accepted in %s\n' "$target" >&2
    exit 1
  fi
  cp "$scratch/original" "$file"
done
printf '%s\n' 'ok: active-target gates and unused-runtime limits reject missing documentation'
