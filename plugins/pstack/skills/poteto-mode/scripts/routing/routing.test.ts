import { describe, expect, it } from "bun:test";
import { resolveRoute } from "./dispatch.ts";
import { parseManifest } from "./manifest.ts";
import { defaultRoleMap, parseLane, parseRoleMap, probePlan, renderLane, type RoleAssignment } from "./role-map.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dispatch = readFileSync(join(import.meta.dir, "../../references/provider-dispatch.md"), "utf8");
const manifest = parseManifest(dispatch);

describe("routing manifest", () => {
  it("recognizes the active GPT-6 families", () => {
    expect(manifest.families.map((family) => family.family)).toEqual(["astra", "sol", "luna"]);
    for (const valid of [
      "codex:gpt-6-astra@xhigh",
      "codex:gpt-6-sol@high",
      "codex:gpt-6-luna@max",
    ]) expect(parseLane(valid, manifest)).toBeDefined();
    for (const invalid of [
      "codex:gpt-6-astra@ultra",
      "claude:gpt-6-sol@max",
      "codex:gpt-6-luna@ultra",
      "claude:claude-fable-5-1@max",
      "codex:gpt-6-missing@max",
    ]) {
      expect(() => parseLane(invalid, manifest)).toThrow();
    }
  });

  it("uses the exact OpenAI-only first-run map", () => {
    const roles = defaultRoleMap(manifest);
    expect(roles.map((role) => role.role).slice(0, 2)).toEqual(["feature implementation", "refactoring implementation"]);
    expect(roles.find((role) => role.role === "feature implementation")?.lanes.map(renderLane)).toEqual(["codex:gpt-6-sol@high"]);
    expect(roles.find((role) => role.role === "refactoring implementation")?.lanes.map(renderLane)).toEqual(["codex:gpt-6-luna@high"]);
    expect(probePlan(roles).map(renderLane)).toEqual(expect.arrayContaining([
      "codex:gpt-6-astra@high", "codex:gpt-6-astra@medium", "codex:gpt-6-astra@xhigh",
      "codex:gpt-6-sol@high", "codex:gpt-6-luna@high", "codex:gpt-6-luna@medium",
    ]));
    expect(probePlan(roles).every((lane) => lane.provider === "codex")).toBe(true);
    expect(probePlan(roles).some((lane) => lane.effort === "max" || lane.effort === "ultra")).toBe(false);
    const expectedPanels = new Map([
      ["how critics", ["codex:gpt-6-astra@medium", "codex:gpt-6-sol@medium"]],
      ["arena runners", ["codex:gpt-6-astra@medium", "codex:gpt-6-sol@medium"]],
      ["arena cross-judge pool", ["codex:gpt-6-astra@medium", "codex:gpt-6-sol@medium"]],
      ["architect runners", ["codex:gpt-6-astra@high", "codex:gpt-6-sol@high"]],
      ["interrogate reviewers", ["codex:gpt-6-astra@medium", "codex:gpt-6-sol@medium"]],
    ]);
    for (const [roleName, expected] of expectedPanels) {
      const lanes = roles.find((role) => role.role === roleName)?.lanes ?? [];
      expect(lanes.map(renderLane)).toEqual(expected);
    }
    expect(roles.find((role) => role.role === "bug-fix")?.lanes.map(renderLane)).toEqual([
      "codex:gpt-6-astra@medium",
    ]);
    expect(roles.find((role) => role.role === "hardest tasks")?.lanes.map(renderLane)).toEqual([
      "codex:gpt-6-astra@xhigh",
    ]);
  });

  it("migrates the one unambiguous legacy combined role into two rows", () => {
    const roles = parseRoleMap("feature, refactoring: codex:gpt-6-sol@high\n", manifest);
    expect(roles.slice(0, 2).map((role) => role.lanes.map(renderLane))).toEqual([
      ["codex:gpt-6-sol@high"],
      ["codex:gpt-6-sol@high"],
    ]);
  });

  it("rejects unknown roles before and after known role rows", () => {
    expect(() => parseRoleMap([
      "featre implementation: codex:gpt-6-sol@high",
      "feature implementation: codex:gpt-6-sol@high",
    ].join("\n"), manifest)).toThrow("unknown role: featre implementation");
    expect(() => parseRoleMap([
      "feature implementation: codex:gpt-6-sol@high",
      "unknown role: codex:gpt-6-sol@max",
    ].join("\n"), manifest)).toThrow("unknown role: unknown role");
  });

  it("replaces an explicit retired source row while validating its structure", () => {
    const edit: RoleAssignment = { role: "hardest tasks", lanes: [parseLane("codex:gpt-6-astra@xhigh", manifest)] };
    expect(parseRoleMap("hardest tasks: claude:claude-fable-5-1@max\n", manifest, [edit])
      .find((role) => role.role === "hardest tasks")?.lanes.map(renderLane)).toEqual(["codex:gpt-6-astra@xhigh"]);
    expect(() => parseRoleMap("hardest tasks: claude:claude-fable-5-1@max\n", manifest)).toThrow("unknown descriptor family");
    expect(() => parseRoleMap("hardest tasks: malformed\n", manifest, [edit])).toThrow("invalid descriptor");
    expect(() => parseRoleMap("hardest tasks: claude:claude-fable-5-1@max, codex:gpt-6-astra@high\n", manifest, [edit])).toThrow("must have exactly one lane");
  });

  it("rejects malformed retired model slugs even when an explicit edit replaces them", () => {
    const edit: RoleAssignment = { role: "hardest tasks", lanes: [parseLane("codex:gpt-6-astra@xhigh", manifest)] };
    for (const malformed of ["claude fable-5-1", "claude:fable-5-1", "claude-fable-5-1?"]) {
      expect(() => parseRoleMap(`hardest tasks: claude:${malformed}@max\n`, manifest, [edit]))
        .toThrow("invalid descriptor");
    }
  });

  it("rejects invalid source identities even when edits replace them", () => {
    const edit: RoleAssignment = { role: "hardest tasks", lanes: [parseLane("codex:gpt-6-astra@xhigh", manifest)] };
    const featureEdit: RoleAssignment = { role: "feature implementation", lanes: [parseLane("codex:gpt-6-sol@high", manifest)] };
    const refactoringEdit: RoleAssignment = { role: "refactoring implementation", lanes: [parseLane("codex:gpt-6-luna@high", manifest)] };
    expect(() => parseRoleMap("unknown role: claude:claude-fable-5-1@max\n", manifest, [edit])).toThrow("unknown role");
    expect(() => parseRoleMap("hardest tasks: claude:claude-fable-5-1@max\nhardest tasks: claude:claude-fable-5-1@max\n", manifest, [edit])).toThrow("duplicate role");
    expect(() => parseRoleMap("feature, refactoring: claude:claude-fable-5-1@max\nfeature implementation: codex:gpt-6-astra@high\n", manifest, [edit, featureEdit, refactoringEdit])).toThrow("duplicate role");
    expect(() => parseRoleMap("hardest tasks:claude:claude-fable-5-1@max\n", manifest, [edit])).toThrow("invalid role row");
    expect(() => parseRoleMap("", manifest, [edit, edit])).toThrow("duplicate role edit");
  });

  it("keeps untouched custom rows and rejects an unedited retired model", () => {
    const edit: RoleAssignment = { role: "hardest tasks", lanes: [parseLane("codex:gpt-6-astra@xhigh", manifest)] };
    const sheet = "hardest tasks: claude:claude-fable-5-1@max\nhow critics: codex:gpt-6-sol@medium, codex:gpt-6-sol@medium\n";
    expect(parseRoleMap(sheet, manifest, [edit]).find((role) => role.role === "how critics")?.lanes.map(renderLane))
      .toEqual(["codex:gpt-6-sol@medium", "codex:gpt-6-sol@medium"]);
    expect(() => parseRoleMap(`${sheet}how explainer: claude:claude-opus-5@xhigh\n`, manifest, [edit]))
      .toThrow("unknown descriptor family");
  });

  it("preserves panel lane order and duplicates while keeping a pool distinct", () => {
    const roles = parseRoleMap([
      "how critics: codex:gpt-6-sol@high, codex:gpt-6-sol@high, codex:gpt-6-astra@high",
      "arena cross-judge pool: codex:gpt-6-sol@high, codex:gpt-6-astra@high",
    ].join("\n"), manifest);
    expect(roles.find((role) => role.role === "how critics")?.lanes.map(renderLane)).toEqual([
      "codex:gpt-6-sol@high", "codex:gpt-6-sol@high", "codex:gpt-6-astra@high",
    ]);
    expect(manifest.roles.find((role) => role.name === "arena cross-judge pool")?.shape).toBe("pool");
    expect(probePlan(roles).filter((lane) => renderLane(lane) === "codex:gpt-6-sol@high")).toHaveLength(1);
  });
});

describe("route resolver", () => {
  it("routes every same-parent descriptor natively and cross-parent descriptor externally", () => {
    expect(resolveRoute("claude", "claude")).toBe("native");
    expect(resolveRoute("claude", "codex")).toBe("external");
    expect(resolveRoute("codex", "codex")).toBe("native");
    expect(resolveRoute("codex", "claude")).toBe("external");
    expect(resolveRoute("claude", "grok")).toBe("external");
    expect(resolveRoute("codex", "grok")).toBe("external");
    expect(resolveRoute("claude", "inherit-parent")).toBe("native");
    expect(resolveRoute("codex", "auto")).toBe("native");
  });
});
