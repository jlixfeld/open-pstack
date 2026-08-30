import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMissingPathError, main } from "./cli.ts";

const manifest = readFileSync(join(import.meta.dir, "../../references/provider-dispatch.md"), "utf8");
const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pstack-setup-cli-"));
  directories.push(directory);
  const paths = {
    manifest: join(directory, "provider-dispatch.md"),
    sheet: join(directory, "pstack-models.md"),
    integration: join(directory, "AGENTS.md"),
    plan: join(directory, "plan.json"),
    probes: join(directory, "probes.json"),
  };
  writeFileSync(paths.manifest, manifest);
  writeFileSync(paths.sheet, "feature, refactoring: codex:gpt-5.6-terra@high\n");
  writeFileSync(paths.integration, "operator notes\n");
  return paths;
}

function prepareArgs(paths: ReturnType<typeof fixture>, edits: readonly string[] = []): string[] {
  return ["prepare", "--parent", "codex", "--manifest", paths.manifest, "--sheet", paths.sheet, "--integration", paths.integration, "--plan", paths.plan, ...edits.flatMap((edit) => ["--edit", edit])];
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
  it("recognizes only ENOENT as a missing target error", () => {
    expect(isMissingPathError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
    expect(isMissingPathError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingPathError(new Error("unknown"))).toBe(false);
  });

  it("prepares private metadata plus a deterministic preview without writing targets", () => {
    const paths = fixture();
    let stdout = "";
    const beforeSheet = readFileSync(paths.sheet, "utf8");
    expect(main(prepareArgs(paths, ["how explorer=codex:gpt-5.6-luna@high"]), { stdout: (value) => { stdout += value; }, stderr: () => {} })).toBe(0);
    const plan = readFileSync(paths.plan, "utf8");
    expect(stdout).toContain("how explorer [1]: codex:gpt-5.6-luna@high (native)");
    expect(plan).toContain('"hash"');
    expect(plan).not.toContain("# pstack model configuration");
    expect(readFileSync(paths.sheet, "utf8")).toBe(beforeSheet);
  });

  it("rejects a stale plan and a failed probe before active writes", () => {
    const paths = fixture();
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    writeFileSync(paths.sheet, "operator change\n");
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(64);
    expect(readFileSync(paths.sheet, "utf8")).toBe("operator change\n");

    rmSync(paths.plan);
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
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    writePassingProbes(paths);
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(0);
    const sheet = readFileSync(paths.sheet, "utf8");
    const integration = readFileSync(paths.integration, "utf8");
    expect(sheet).toContain("feature implementation: codex:gpt-5.6-terra@high");
    expect(integration).toContain("<!-- pstack:models:begin -->");

    rmSync(paths.plan);
    expect(main(prepareArgs(paths), { stdout: () => {}, stderr: () => {} })).toBe(0);
    writePassingProbes(paths);
    expect(main(["commit", "--plan", paths.plan, "--probe-results", paths.probes], { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(readFileSync(paths.sheet, "utf8")).toBe(sheet);
    expect(readFileSync(paths.integration, "utf8")).toBe(integration);
  });
});
