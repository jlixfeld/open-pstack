import { describe, expect, it } from "bun:test";
import { resolveRoute } from "./dispatch.ts";
import { parseManifest } from "./manifest.ts";
import { defaultRoleMap, parseLane, parseRoleMap, probePlan, renderLane } from "./role-map.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dispatch = readFileSync(join(import.meta.dir, "../../references/provider-dispatch.md"), "utf8");
const manifest = parseManifest(dispatch);

describe("routing manifest", () => {
  it("recognizes every supported family and family-specific efforts", () => {
    expect(manifest.families.map((family) => family.family)).toEqual(["fable", "sol", "terra", "luna", "grok", "opus"]);
    for (const valid of [
      "claude:claude-fable-5-1@max",
      "codex:gpt-5.6-sol@ultra",
      "codex:gpt-5.6-terra@ultra",
      "codex:gpt-5.6-luna@max",
      "grok:grok-4.6@xhigh",
      "claude:claude-opus-5@xhigh",
    ]) expect(parseLane(valid, manifest)).toBeDefined();
    for (const invalid of [
      "claude:gpt-5.6-sol@max",
      "codex:claude-fable-5-1@max",
      "codex:gpt-5.6-luna@ultra",
      "grok:grok-4.6@ultra",
      "codex:gpt-5.6-missing@max",
      "grok:grok-4.6@invalid",
    ]) {
      expect(() => parseLane(invalid, manifest)).toThrow();
    }
  });

  it("uses the exact split first-run map without requiring optional families", () => {
    const roles = defaultRoleMap(manifest);
    expect(roles.map((role) => role.role).slice(0, 2)).toEqual(["feature implementation", "refactoring implementation"]);
    expect(roles.find((role) => role.role === "feature implementation")?.lanes.map(renderLane)).toEqual(["codex:gpt-5.6-terra@high"]);
    expect(roles.find((role) => role.role === "refactoring implementation")?.lanes.map(renderLane)).toEqual(["codex:gpt-5.6-luna@high"]);
    expect(probePlan(roles).map(renderLane)).toContain("claude:claude-fable-5-1@max");
    expect(probePlan(roles).map(renderLane)).not.toContain("grok:grok-4.6@xhigh");
    for (const roleName of ["how critics", "arena runners", "architect runners", "interrogate reviewers"]) {
      const lanes = roles.find((role) => role.role === roleName)?.lanes ?? [];
      expect(lanes.map(renderLane)).toEqual(roleName === "how critics" || roleName === "interrogate reviewers"
        ? ["codex:gpt-5.6-sol@max", "claude:claude-fable-5-1@max"]
        : ["codex:gpt-5.6-sol@max", "claude:claude-opus-5@xhigh"]);
      expect(new Set(lanes.map((lane) => renderLane(lane).split(":", 1)[0])).size).toBe(lanes.length);
    }
    expect(roles.find((role) => role.role === "hardest tasks")?.lanes.map(renderLane)).toEqual([
      "claude:claude-fable-5-1@max",
    ]);
  });

  it("migrates the one unambiguous legacy combined role into two rows", () => {
    const roles = parseRoleMap("feature, refactoring: codex:gpt-5.6-terra@high\n", manifest);
    expect(roles.slice(0, 2).map((role) => role.lanes.map(renderLane))).toEqual([
      ["codex:gpt-5.6-terra@high"],
      ["codex:gpt-5.6-terra@high"],
    ]);
  });

  it("rejects unknown roles before and after known role rows", () => {
    expect(() => parseRoleMap([
      "featre implementation: codex:gpt-5.6-terra@high",
      "feature implementation: codex:gpt-5.6-terra@high",
    ].join("\n"), manifest)).toThrow("unknown role: featre implementation");
    expect(() => parseRoleMap([
      "feature implementation: codex:gpt-5.6-terra@high",
      "unknown role: codex:gpt-5.6-sol@max",
    ].join("\n"), manifest)).toThrow("unknown role: unknown role");
  });

  it("preserves panel lane order and duplicates while keeping a pool distinct", () => {
    const roles = parseRoleMap([
      "how critics: codex:gpt-5.6-sol@max, codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh",
      "arena cross-judge pool: codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh",
    ].join("\n"), manifest);
    expect(roles.find((role) => role.role === "how critics")?.lanes.map(renderLane)).toEqual([
      "codex:gpt-5.6-sol@max", "codex:gpt-5.6-sol@max", "claude:claude-opus-5@xhigh",
    ]);
    expect(manifest.roles.find((role) => role.name === "arena cross-judge pool")?.shape).toBe("pool");
    expect(probePlan(roles).filter((lane) => renderLane(lane) === "codex:gpt-5.6-sol@max")).toHaveLength(1);
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
