import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRoute } from "./dispatch.ts";
import { parseManifest } from "./manifest.ts";
import { parseLane, parseRoleMap, probePlan, renderLane, renderRoleMap, type RoleAssignment } from "./role-map.ts";

const dispatch = readFileSync(join(import.meta.dir, "../../references/provider-dispatch.md"), "utf8");
const manifest = parseManifest(dispatch);
const complete = (lane: string): string => manifest.roles.map((role) => `${role.name}: ${lane}`).join("\n") + "\n";

describe("personal role map", () => {
  it("accepts native Claude or Codex descriptors without choosing a model", () => {
    expect(renderLane(parseLane("claude:claude-opus-5-5@high"))).toBe("claude:claude-opus-5-5@high");
    expect(renderLane(parseLane("codex:gpt-6.1-sol@medium"))).toBe("codex:gpt-6.1-sol@medium");
    for (const invalid of ["claude-opus", "openai:model@high", "claude:bad model@high", "codex:model@other"])
      expect(() => parseLane(invalid)).toThrow();
  });

  it("requires every role and never inserts an alias or model", () => {
    expect(() => parseRoleMap("", manifest)).toThrow("missing shared agent model assignments: feature implementation");
    expect(() => parseRoleMap("feature implementation: inherit-parent\n", manifest)).toThrow("missing shared agent model assignments: refactoring implementation");
    const roles = parseRoleMap(complete("inherit-parent"), manifest);
    expect(roles).toHaveLength(manifest.roles.length);
    expect(roles.every((role) => role.lanes.length === 1 && role.lanes[0] === "inherit-parent")).toBe(true);
    expect(probePlan(roles)).toEqual([]);
  });

  it("allows an explicit edit for each missing upgrade role", () => {
    const sheet = complete("auto").replace("hardest tasks: auto\n", "");
    const edit: RoleAssignment = { role: "hardest tasks", lanes: [parseLane("claude:claude-opus-5-5@high")] };
    expect(() => parseRoleMap(sheet, manifest)).toThrow("hardest tasks");
    expect(parseRoleMap(sheet, manifest, [edit]).find((role) => role.role === "hardest tasks")?.lanes.map(renderLane))
      .toEqual(["claude:claude-opus-5-5@high"]);
  });

  it("resolves configured roles from a partial upgrade map while setup still rejects it", () => {
    const upgraded = { roles: [...manifest.roles, { name: "upgrade role", shape: "single" as const }] };
    const sheet = complete("auto");
    expect(() => parseRoleMap(sheet, upgraded)).toThrow("upgrade role");
    expect(parseRoleMap(sheet, upgraded, [], false).find((role) => role.role === "feature implementation")?.lanes.map(renderLane)).toEqual(["auto"]);
    expect(parseRoleMap(sheet, upgraded, [], false).some((role) => role.role === "upgrade role")).toBe(false);
  });

  it("expands a legacy combined row without altering its descriptor", () => {
    const sheet = complete("auto")
      .replace("feature implementation: auto\nrefactoring implementation: auto\n", "feature, refactoring: codex:gpt-6.1-sol@high\n");
    expect(parseRoleMap(sheet, manifest).slice(0, 2).map((role) => role.lanes.map(renderLane)))
      .toEqual([["codex:gpt-6.1-sol@high"], ["codex:gpt-6.1-sol@high"]]);
  });

  it("preserves panel order, duplicate lanes, and distinct pool shape", () => {
    const sheet = complete("auto").replace("how critics: auto\n", "how critics: claude:claude-opus-5-5@high, claude:claude-opus-5-5@high, codex:gpt-6.1-sol@medium\n");
    const roles = parseRoleMap(sheet, manifest);
    expect(roles.find((role) => role.role === "how critics")?.lanes.map(renderLane)).toEqual([
      "claude:claude-opus-5-5@high", "claude:claude-opus-5-5@high", "codex:gpt-6.1-sol@medium",
    ]);
    expect(manifest.roles.find((role) => role.name === "arena cross-judge pool")?.shape).toBe("pool");
    expect(probePlan(roles).map(renderLane)).toEqual(["claude:claude-opus-5-5@high", "codex:gpt-6.1-sol@medium"]);
    expect(renderRoleMap(roles)).toContain("how critics: claude:claude-opus-5-5@high, claude:claude-opus-5-5@high, codex:gpt-6.1-sol@medium");
  });

  it("rejects malformed, unknown, duplicate, and wrong-shape entries before launching", () => {
    for (const bad of [
      complete("auto").replace("bug-fix: auto", "bug-fix: malformed"),
      `${complete("auto")}unknown role: auto\n`,
      `${complete("auto")}bug-fix: auto\n`,
      complete("auto").replace("bug-fix: auto", "bug-fix: auto, auto"),
    ]) expect(() => parseRoleMap(bad, manifest)).toThrow();
  });

  it("keeps edits explicit and validates source rows", () => {
    const edit: RoleAssignment = { role: "hardest tasks", lanes: [parseLane("codex:gpt-6.1-sol@high")] };
    expect(() => parseRoleMap(complete("auto").replace("hardest tasks: auto", "hardest tasks: malformed"), manifest, [edit])).toThrow("invalid descriptor");
    expect(() => parseRoleMap(complete("auto"), manifest, [edit, edit])).toThrow("duplicate role edit");
  });
});

describe("route resolver", () => {
  it("keeps explicit same-parent and alias routes native", () => {
    expect(resolveRoute("claude", "claude")).toBe("native");
    expect(resolveRoute("claude", "codex")).toBe("external");
    expect(resolveRoute("codex", "codex")).toBe("native");
    expect(resolveRoute("codex", "claude")).toBe("external");
    expect(resolveRoute("claude", "grok")).toBe("external");
    expect(resolveRoute("claude", "inherit-parent")).toBe("native");
    expect(resolveRoute("codex", "auto")).toBe("native");
  });
});
