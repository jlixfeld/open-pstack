import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalTarget, commit, isMissingPathError, main, prepare } from "./cli.ts";
import { parseManifest } from "../routing/manifest.ts";

const manifest = readFileSync(join(import.meta.dir, "../../references/provider-dispatch.md"), "utf8");
const fullSheet = parseManifest(manifest).roles.map((role) => `${role.name}: inherit-parent`).join("\n") + "\n";
const legacySheet = fullSheet.replace("feature implementation: inherit-parent\nrefactoring implementation: inherit-parent\n", "feature, refactoring: codex:gpt-6.1-sol@high\n");
const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pstack-setup-cli-"));
  directories.push(directory);
  const paths = {
    manifest: join(directory, "provider-dispatch.md"),
    sheet: join(directory, "agent-model-map.md"),
    integration: join(directory, "AGENTS.md"),
    plan: join(directory, "plan.json"),
    probes: join(directory, "probes.json"),
  };
  writeFileSync(paths.manifest, manifest);
  writeFileSync(paths.sheet, legacySheet);
  writeFileSync(paths.integration, "operator notes\n");
  return paths;
}

function prepareArgs(paths: ReturnType<typeof fixture>, edits: readonly string[] = []): string[] {
  return ["prepare", "--parent", "codex", "--manifest", paths.manifest, "--map", paths.sheet, "--integration", paths.integration, "--plan", paths.plan, ...edits.flatMap((edit) => ["--edit", edit])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function planProbes(path: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("invalid test plan");
  const value = parsed.probes;
  if (!Array.isArray(value) || !value.every((probe) => typeof probe === "string")) throw new Error("invalid test plan probes");
  return value;
}

function writePassingProbes(paths: ReturnType<typeof fixture>): void {
  writeFileSync(paths.probes, JSON.stringify(planProbes(paths.plan).map((descriptor) => ({ descriptor, passed: true }))));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("pstack-setup CLI", () => {
  it("resolves only stored lanes and fails closed for missing or malformed maps", () => {
    const paths = fixture();
    const args = ["resolve", "--parent", "claude", "--manifest", paths.manifest, "--map", paths.sheet, "--role", "arena runners"];
    writeFileSync(paths.sheet, fullSheet.replace("arena runners: inherit-parent", "arena runners: claude:claude-opus-5-5@high, claude:claude-opus-5-5@high"));
    let output = "";
    expect(main(args, { stdout: (value) => { output += value; }, stderr: () => {} })).toBe(0);
    expect(JSON.parse(output)).toEqual({
      map: paths.sheet,
      role: "arena runners",
      shape: "panel",
      lanes: [
        { descriptor: "claude:claude-opus-5-5@high", route: "native" },
        { descriptor: "claude:claude-opus-5-5@high", route: "native" },
      ],
    });
    writeFileSync(paths.sheet, fullSheet.replace("arena runners: inherit-parent\n", ""));
    let error = "";
    expect(main(args, { stdout: () => {}, stderr: (value) => { error += value; } })).toBe(64);
    expect(error).toContain("arena runners");
    rmSync(paths.sheet);
    error = "";
    expect(main(args, { stdout: () => {}, stderr: (value) => { error += value; } })).toBe(64);
    expect(error).toContain("missing shared agent model map");
  });

  it("keeps configured workflows usable when an upgrade adds an unrelated role", () => {
    const paths = fixture();
    writeFileSync(paths.manifest, manifest.replace("| interrogate reviewers | panel |", "| interrogate reviewers | panel |\n| upgrade role | single |"));
    let output = "";
    expect(main(["resolve", "--parent", "codex", "--manifest", paths.manifest, "--map", paths.sheet, "--role", "feature implementation"], {
      stdout: (value) => { output += value; }, stderr: () => {},
    })).toBe(0);
    expect(JSON.parse(output).lanes).toEqual([{ descriptor: "codex:gpt-6.1-sol@high", route: "native" }]);

    let error = "";
    expect(main(["resolve", "--parent", "codex", "--manifest", paths.manifest, "--map", paths.sheet, "--role", "upgrade role"], {
      stdout: () => {}, stderr: (value) => { error += value; },
    })).toBe(64);
    expect(error).toContain("missing pstack model assignment for role: upgrade role");
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(64);
    expect(existsSync(paths.plan)).toBe(false);
  });

  it("requires explicit assignments on a fresh installation", () => {
    const paths = fixture();
    rmSync(paths.sheet);
    let stderr = "";
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: (value) => { stderr += value; } })).toBe(64);
    expect(stderr).toContain("missing shared agent model assignments");
    expect(stderr).toContain("feature implementation");
    expect(existsSync(paths.plan)).toBe(false);
    expect(existsSync(paths.sheet)).toBe(false);

    const edits = parseManifest(manifest).roles.map((role) => `${role.name}=inherit-parent`);
    expect(main(prepareArgs(paths, edits), { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(planProbes(paths.plan)).toEqual([]);
    expect(existsSync(paths.sheet)).toBe(false);
  });

  it("reports a newly required role without changing an existing personal sheet", () => {
    const paths = fixture();
    const before = fullSheet.replace("how critics: inherit-parent\n", "");
    writeFileSync(paths.sheet, before);
    let stderr = "";
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: (value) => { stderr += value; } })).toBe(64);
    expect(stderr).toContain("how critics");
    expect(readFileSync(paths.sheet, "utf8")).toBe(before);
    expect(existsSync(paths.plan)).toBe(false);
    expect(main(prepareArgs(paths, ["how critics=inherit-parent,inherit-parent"]), { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(readFileSync(paths.sheet, "utf8")).toBe(before);
  });

  it("canonicalizes tilde and relative setup targets while preserving include aliases", () => {
    expect(canonicalTarget("~/.claude/agent-model-map.md", "/work/repo", "/Users/operator")).toEqual({
      path: "/Users/operator/.claude/agent-model-map.md",
      aliases: ["/Users/operator/.claude/agent-model-map.md", "~/.claude/agent-model-map.md"],
    });
    expect(canonicalTarget("config/models.md", "/work/repo", "/Users/operator")).toEqual({
      path: "/work/repo/config/models.md",
      aliases: ["/work/repo/config/models.md", "config/models.md"],
    });
  });

  it("recognizes only ENOENT as a missing target error", () => {
    expect(isMissingPathError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
    expect(isMissingPathError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingPathError(new Error("unknown"))).toBe(false);
  });

  it("prepares private metadata plus a deterministic preview without writing targets", () => {
    const paths = fixture();
    let stdout = "";
    const beforeSheet = readFileSync(paths.sheet, "utf8");
    expect(main(prepareArgs(paths, ["how explorer=codex:gpt-6-luna@high"]), { stdout: (value) => { stdout += value; }, stderr: () => {} })).toBe(0);
    const plan = readFileSync(paths.plan, "utf8");
    expect(stdout).toContain("how explorer [1]: codex:gpt-6-luna@high (native)");
    expect(plan).toContain('"hash"');
    expect(plan).not.toContain("# shared agent model map");
    expect(readFileSync(paths.sheet, "utf8")).toBe(beforeSheet);
  });

  it("replays an explicit replacement for a retired sheet row through commit", () => {
    const paths = fixture();
    writeFileSync(paths.sheet, legacySheet.replace("hardest tasks: inherit-parent", "hardest tasks: claude:claude-fable-5-1@max"));
    expect(main(prepareArgs(paths, ["hardest tasks=codex:gpt-6-astra@xhigh"]), { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(planProbes(paths.plan)).toContain("codex:gpt-6-astra@xhigh");
    writePassingProbes(paths);
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(readFileSync(paths.sheet, "utf8")).toContain("hardest tasks: codex:gpt-6-astra@xhigh");
  });

  it("binds the plan hash to the exact snapshots used for preview", () => {
    const paths = fixture();
    let mutated = false;
    prepare(prepareArgs(paths).slice(1), { stdout: () => {}, stderr: () => {} }, (path) => {
      const bytes = readFileSync(path);
      if (path === paths.sheet && !mutated) {
        mutated = true;
        writeFileSync(path, "concurrent operator change\n");
      }
      return { path, bytes };
    });
    writePassingProbes(paths);
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(64);
    expect(readFileSync(paths.sheet, "utf8")).toBe("concurrent operator change\n");
  });

  it("binds commit rendering to the exact snapshots used for drift checks", () => {
    const paths = fixture();
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    writePassingProbes(paths);
    let mutated = false;
    expect(() => commit(["--plan", paths.plan, "--probe-results", paths.probes], (path) => {
      const bytes = readFileSync(path);
      if (path === paths.sheet && !mutated) {
        mutated = true;
        writeFileSync(path, "concurrent commit change\n");
      }
      return { path, bytes };
    })).toThrow("stale setup baseline");
    expect(readFileSync(paths.sheet, "utf8")).toBe("concurrent commit change\n");
  });

  it("rejects symlink-backed targets without replacing the link", () => {
    const paths = fixture();
    const linkedSheet = join(paths.sheet, "..", "managed-models.md");
    writeFileSync(linkedSheet, readFileSync(paths.sheet));
    rmSync(paths.sheet);
    symlinkSync(linkedSheet, paths.sheet);
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(64);
    expect(lstatSync(paths.sheet).isSymbolicLink()).toBe(true);
    expect(existsSync(paths.plan)).toBe(false);
    expect(readFileSync(linkedSheet, "utf8")).toContain("feature, refactoring");
  });

  it("rejects a target changed to a symlink after prepare", () => {
    const paths = fixture();
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    writePassingProbes(paths);
    const linkedIntegration = join(paths.integration, "..", "managed-agents.md");
    writeFileSync(linkedIntegration, readFileSync(paths.integration));
    rmSync(paths.integration);
    symlinkSync(linkedIntegration, paths.integration);
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(64);
    expect(lstatSync(paths.integration).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkedIntegration, "utf8")).toBe("operator notes\n");
  });

  it("rejects a stale plan and a failed probe before active writes", () => {
    const paths = fixture();
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    writeFileSync(paths.sheet, "operator change\n");
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(64);
    expect(readFileSync(paths.sheet, "utf8")).toBe("operator change\n");

    rmSync(paths.plan);
    writeFileSync(paths.sheet, legacySheet);
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    writeFileSync(paths.probes, JSON.stringify(planProbes(paths.plan).map((descriptor, index) => ({ descriptor, passed: index !== 0 }))));
    const before = readFileSync(paths.sheet, "utf8");
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(64);
    expect(readFileSync(paths.sheet, "utf8")).toBe(before);
  });

  it("creates plans exclusively without changing the original plan or active targets", () => {
    const paths = fixture();
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    const plan = readFileSync(paths.plan, "utf8");
    const sheet = readFileSync(paths.sheet, "utf8");
    const integration = readFileSync(paths.integration, "utf8");
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(64);
    expect(readFileSync(paths.plan, "utf8")).toBe(plan);
    expect(readFileSync(paths.sheet, "utf8")).toBe(sheet);
    expect(readFileSync(paths.integration, "utf8")).toBe(integration);
  });

  it("commits a passing exact result set and leaves an unchanged rerun byte-identical", () => {
    const paths = fixture();
    chmodSync(paths.sheet, 0o640);
    chmodSync(paths.integration, 0o644);
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    writePassingProbes(paths);
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(0);
    const sheet = readFileSync(paths.sheet, "utf8");
    const integration = readFileSync(paths.integration, "utf8");
    expect(sheet).toContain("feature implementation: codex:gpt-6.1-sol@high");
    expect(integration).toContain("<!-- agent:model-map:begin -->");
    expect(statSync(paths.sheet).mode & 0o777).toBe(0o640);
    expect(statSync(paths.integration).mode & 0o777).toBe(0o644);

    rmSync(paths.plan);
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    writePassingProbes(paths);
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(readFileSync(paths.sheet, "utf8")).toBe(sheet);
    expect(readFileSync(paths.integration, "utf8")).toBe(integration);
  });

  it("preserves prepared Claude include aliases through commit", () => {
    const paths = fixture();
    writeFileSync(paths.integration, "operator notes\n@~/.claude/agent-model-map.md\n");
    const args = prepareArgs(paths);
    args[args.indexOf("codex")] = "claude";
    expect(main(args, { stdout: () => {}, stderr: () => {} })).toBe(0);
    const plan = JSON.parse(readFileSync(paths.plan, "utf8"));
    plan.sheetAliases.push("~/.claude/agent-model-map.md");
    writeFileSync(paths.plan, `${JSON.stringify(plan, null, 2)}\n`);
    writePassingProbes(paths);

    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(0);
    const integration = readFileSync(paths.integration, "utf8");
    expect(integration).toBe(`operator notes\n@${paths.sheet}\n`);
  });
});
