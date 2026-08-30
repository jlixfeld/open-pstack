import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareSetup } from "./engine.ts";
import { commitSetup, type SetupFilesystem } from "./transaction.ts";

const manifestMarkdown = readFileSync(join(import.meta.dir, "../../references/provider-dispatch.md"), "utf8");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeFilesystem implements SetupFilesystem {
  readonly files = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  failWrite: string | null = null;
  failWriteCreates: { readonly path: string; readonly text: string } | null = null;
  failReadback: string | null = null;

  constructor(initial: readonly { readonly path: string; readonly text: string }[]) {
    for (const entry of initial) this.files.set(entry.path, encoder.encode(entry.text));
  }
  read(path: string): Uint8Array | null {
    if (this.failReadback === path) return encoder.encode("wrong");
    return this.files.get(path) ?? null;
  }
  replaceAtomically(path: string, bytes: Uint8Array): void {
    this.writes.push(path);
    if (this.failWriteCreates?.path === path) {
      this.files.set(path, encoder.encode(this.failWriteCreates.text));
      throw new Error(`write raced: ${path}`);
    }
    if (this.failWrite === path) throw new Error(`write failed: ${path}`);
    this.files.set(path, bytes);
  }
  remove(path: string): void { this.files.delete(path); }
  value(path: string): string | null { const bytes = this.files.get(path); return bytes === undefined ? null : decoder.decode(bytes); }
}

function prepared(parent: "claude" | "codex" = "codex") {
  const fs = new FakeFilesystem([{ path: "sheet", text: "feature, refactoring: codex:gpt-5.6-terra@high\n" }, { path: "integration", text: "old\n" }]);
  return {
    fs,
    value: prepareSetup({
      parent,
      manifestMarkdown,
      sheet: { path: "sheet", bytes: fs.read("sheet") },
      integration: { path: "integration", bytes: fs.read("integration") },
    }),
  };
}

function passed(value: ReturnType<typeof prepareSetup>) {
  return value.probes.map((probe) => ({ descriptor: `${probe.provider}:${probe.model}@${probe.effort}`, passed: true }));
}

describe("prepare setup", () => {
  it("recognizes only exact Claude include lines", () => {
    const make = (integration: string | null) => prepareSetup({
      parent: "claude",
      manifestMarkdown,
      sheet: { path: "sheet", bytes: null },
      integration: { path: "integration", bytes: integration === null ? null : encoder.encode(integration) },
    });
    expect(decoder.decode(make(null).targets[1].nextBytes)).toBe("@~/.claude/pstack-models.md\n");
    expect(decoder.decode(make("before\n@~/.claude/pstack-models.md\n").targets[1].nextBytes)).toBe("before\n@~/.claude/pstack-models.md\n");
    expect(decoder.decode(make("note @~/.claude/pstack-models.md in prose\n").targets[1].nextBytes)).toBe("note @~/.claude/pstack-models.md in prose\n@~/.claude/pstack-models.md\n");
    expect(() => make("@~/.claude/pstack-models.md\n@~/.claude/pstack-models.md\n")).toThrow("duplicate Claude pstack include");
  });

  it("rejects inconsistent Codex marker boundaries and replaces one exact block", () => {
    const make = (integration: string) => prepareSetup({
      parent: "codex",
      manifestMarkdown,
      sheet: { path: "sheet", bytes: null },
      integration: { path: "integration", bytes: encoder.encode(integration) },
    });
    expect(decoder.decode(make("before\n<!-- pstack:models:begin -->\nold\n<!-- pstack:models:end -->\nafter\n").targets[1].nextBytes)).toContain("before\n<!-- pstack:models:begin -->\n# pstack model configuration");
    expect(() => make("<!-- pstack:models:begin -->\n")).toThrow("inconsistent Codex pstack markers");
    expect(() => make("<!-- pstack:models:end -->\n")).toThrow("inconsistent Codex pstack markers");
  });

  it("renders a deterministic full preview and derives probes only from the final map", () => {
    const { value } = prepared();
    expect(value.preview[0]).toBe("feature implementation [1]: codex:gpt-5.6-terra@high (native)");
    expect(value.preview.some((line) => line.includes("arena cross-judge pool [1]"))).toBe(true);
    expect(value.probes.map((probe) => `${probe.provider}:${probe.model}@${probe.effort}`)).not.toContain("claude:claude-fable-5@max");
    expect(value.targets[0].nextBytes).not.toEqual(value.targets[0].bytes);
  });

  it("performs no active write when final-map probes fail", () => {
    const { fs, value } = prepared();
    expect(() => commitSetup(value, value.probes.map((probe, index) => ({ descriptor: `${probe.provider}:${probe.model}@${probe.effort}`, passed: index !== 0 })), fs)).toThrow("all final-map probes");
    expect(fs.writes).toEqual([]);
  });

  it("does not accept a successful result for a different descriptor", () => {
    const { fs, value } = prepared();
    const results = passed(value);
    results[0] = { descriptor: "codex:gpt-5.6-sol@max", passed: true };
    expect(() => commitSetup(value, results, fs)).toThrow("all final-map probes");
    expect(fs.writes).toEqual([]);
  });

  it("aborts stale baselines before writing", () => {
    const { fs, value } = prepared();
    fs.files.set("sheet", encoder.encode("changed"));
    expect(() => commitSetup(value, passed(value), fs)).toThrow("stale setup baseline");
    expect(fs.writes).toEqual([]);
  });

  it("restores both snapshots after a write or readback failure", () => {
    for (const failure of ["write", "readback"] as const) {
      const { fs, value } = prepared();
      const beforeSheet = fs.value("sheet");
      const beforeIntegration = fs.value("integration");
      if (failure === "write") fs.failWrite = "integration";
      else fs.failReadback = "integration";
      expect(() => commitSetup(value, passed(value), fs)).toThrow();
      expect(fs.value("sheet")).toBe(beforeSheet);
      expect(fs.value("integration")).toBe(beforeIntegration);
    }
  });

  it("removes newly created targets while restoring existing targets after failures", () => {
    for (const initial of [
      [{ path: "integration", text: "old\n" }],
      [{ path: "sheet", text: "feature implementation: codex:gpt-5.6-terra@high\n" }],
    ]) {
      const fs = new FakeFilesystem(initial);
      const value = prepareSetup({
        parent: "codex",
        manifestMarkdown,
        sheet: { path: "sheet", bytes: fs.read("sheet") },
        integration: { path: "integration", bytes: fs.read("integration") },
      });
      const beforeSheet = fs.value("sheet");
      const beforeIntegration = fs.value("integration");
      fs.failReadback = "integration";
      expect(() => commitSetup(value, passed(value), fs)).toThrow();
      expect(fs.value("sheet")).toBe(beforeSheet);
      expect(fs.value("integration")).toBe(beforeIntegration);
    }
  });

  it("does not remove an absent target created by another actor during a failed write", () => {
    const fs = new FakeFilesystem([{ path: "integration", text: "old\n" }]);
    const value = prepareSetup({
      parent: "codex",
      manifestMarkdown,
      sheet: { path: "sheet", bytes: null },
      integration: { path: "integration", bytes: fs.read("integration") },
    });
    fs.failWriteCreates = { path: "sheet", text: "external actor\n" };
    expect(() => commitSetup(value, passed(value), fs)).toThrow("write raced");
    expect(fs.value("sheet")).toBe("external actor\n");
    expect(fs.value("integration")).toBe("old\n");
  });

  it("does no writes on a byte-identical rerun", () => {
    const first = prepared("claude");
    commitSetup(first.value, passed(first.value), first.fs);
    first.fs.writes.splice(0);
    const rerun = prepareSetup({
      parent: "claude",
      manifestMarkdown,
      sheet: { path: "sheet", bytes: first.fs.read("sheet") },
      integration: { path: "integration", bytes: first.fs.read("integration") },
    });
    commitSetup(rerun, passed(rerun), first.fs);
    expect(first.fs.writes).toEqual([]);
  });
});
