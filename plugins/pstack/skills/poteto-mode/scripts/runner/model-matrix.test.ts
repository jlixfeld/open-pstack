import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "../routing/manifest.ts";
import { ROLE_MAP_PREAMBLE } from "../routing/role-map.ts";

const plugin = join(import.meta.dir, "../../../..");
const dispatch = readFileSync(join(plugin, "skills/poteto-mode/references/provider-dispatch.md"), "utf8");
const setup = readFileSync(join(plugin, "skills/setup-pstack/SKILL.md"), "utf8");

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("map-only routing contract", () => {
  it("declares only role names and shapes in the registry", () => {
    const roles = parseManifest(dispatch).roles;
    expect(roles).toHaveLength(17);
    expect(roles.find((role) => role.name === "arena cross-judge pool")?.shape).toBe("pool");
    expect(dispatch).not.toContain("## Model matrix");
    expect(dispatch).not.toContain("First-run lanes");
    expect(roles.every((role) => Object.keys(role).sort().join(",") === "name,shape")).toBe(true);
  });

  it("requires explicit assignments in setup and workflow instructions", () => {
    expect(setup).toContain("Ask the operator to assign each missing role explicitly");
    expect(setup).toContain("Offer no first-run values");
    expect(setup).toContain("stops before launch");
    expect(ROLE_MAP_PREAMBLE).toContain("standing authorization");
    for (const skill of ["arena", "architect", "how", "interrogate", "swarm", "why", "reflect", "poteto-mode"]) {
      const content = readFileSync(join(plugin, `skills/${skill}/SKILL.md`), "utf8");
      expect(content).not.toMatch(/default `(?:claude|codex|grok):[^`]+`/i);
      expect(content).not.toMatch(/if the sheet or (?:that )?(?:line|role) is missing, use /i);
    }
  });

  it("ships no concrete model assignment in active skill Markdown", () => {
    for (const path of markdownFiles(join(plugin, "skills"))) {
      expect(readFileSync(path, "utf8")).not.toMatch(/(?:claude|codex|grok):[a-z0-9.-]+@(low|medium|high|xhigh|max|ultra)\b/);
    }
  });

  it("retains the existing personal paths and transactional protocol", () => {
    expect(setup).toContain("~/.claude/pstack-models.md");
    expect(setup).toContain("~/.codex/pstack-models.md");
    expect(setup).toContain("pstack-setup prepare");
    expect(setup).toContain("pstack-setup commit");
    expect(setup).toContain("rolls back failed writes or readbacks");
  });
});
