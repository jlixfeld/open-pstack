import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.ts";

const directories: string[] = [];
const stores: Store[] = [];

async function fixture(): Promise<{ readonly directory: string; readonly store: Store; readonly prompt: string }> {
  const directory = await mkdtemp(join(tmpdir(), "orch-lanes-"));
  directories.push(directory);
  const store = openStore(directory);
  stores.push(store);
  await store.init();
  await store.units.add({ id: "unit", track: "test" });
  const prompt = join(directory, "source-prompt.md");
  await writeFile(prompt, "mandatory claude review\n");
  return { directory, store, prompt };
}

async function register(store: Store, prompt: string): Promise<void> {
  await store.lanes.register({
    laneId: "claude-review",
    unitId: "unit",
    parent: "codex",
    provider: "claude",
    model: "claude-opus-5",
    effort: "xhigh",
    mode: "read-only",
    promptPath: prompt,
    cwd: "/tmp",
  });
}

async function complete(plan: { readonly laneId: string; readonly attemptId: string; readonly argv: readonly string[]; readonly outputPath: string; readonly receiptPath: string }): Promise<void> {
  const value = (name: string): string => {
    const index = plan.argv.indexOf(name);
    const result = plan.argv[index + 1];
    if (index < 0 || result === undefined) throw new Error(`missing ${name}`);
    return result;
  };
  await writeFile(plan.outputPath, "review complete\n");
  await writeFile(plan.receiptPath, JSON.stringify({
    schemaVersion: 2,
    status: "complete",
    parent: value("--parent"), provider: value("--provider"), model: value("--model"), effort: value("--effort"), mode: value("--mode"),
    cwd: value("--cwd"), promptPath: value("--prompt"), outputPath: plan.outputPath, receiptPath: plan.receiptPath,
    timeoutMs: null, exitCode: 0, reportedModel: "claude-opus-5", modelVerified: true, modelEvidence: "provider-report",
    managedAttempt: { verified: true, laneId: plan.laneId, attemptId: plan.attemptId, laneFingerprint: value("--lane-fingerprint"), promptSha256: value("--prompt-sha256") },
  }));
}

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) await store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("managed provider lanes", () => {
  it("registers before launch, replays a restart plan, and blocks unit state", async () => {
    const { store, prompt } = await fixture();
    await register(store, prompt);
    await expect(store.units.set({ id: "unit", state: "done" })).rejects.toThrow("incomplete managed provider lanes");
    const first = await store.lanes.tick();
    const restarted = await store.lanes.tick();
    expect(first).toHaveLength(1);
    expect(restarted).toEqual(first);
    expect(first[0]?.argv).toContain("--lane-fingerprint");
  });

  it("validates completion continuously and fails closed after output tampering", async () => {
    const { store, prompt } = await fixture();
    await register(store, prompt);
    const [plan] = await store.lanes.tick();
    if (plan === undefined) throw new Error("missing launch plan");
    await complete(plan);
    await store.lanes.tick();
    expect(await store.lanes.check("unit")).toBe(true);
    await writeFile(plan.outputPath, "changed\n");
    expect(await store.lanes.check("unit")).toBe(false);
  });

  it("refuses a stale release and retains a claimed reservation without a timeout", async () => {
    const { store, prompt } = await fixture();
    await register(store, prompt);
    const [plan] = await store.lanes.tick();
    if (plan === undefined) throw new Error("missing launch plan");
    await writeFile(plan.outputPath, "");
    await expect(store.lanes.release({ laneId: plan.laneId, attemptId: "old", reason: "dead pid 12" })).rejects.toThrow("does not have claimed attempt");
    expect(await store.lanes.tick()).toEqual([]);
    await store.lanes.release({ laneId: plan.laneId, attemptId: plan.attemptId, reason: "dead pid 12" });
    const retry = await store.lanes.retry(plan.laneId);
    expect(retry.attemptId).not.toBe(plan.attemptId);
    expect(retry.outputPath).not.toBe(plan.outputPath);
  });

  it("records a Claude pause for the default 30-minute retry without launching early", async () => {
    const { directory, store, prompt } = await fixture();
    await register(store, prompt);
    const [plan] = await store.lanes.tick();
    if (plan === undefined) throw new Error("missing launch plan");
    const value = (name: string): string => {
      const index = plan.argv.indexOf(name);
      const result = plan.argv[index + 1];
      if (index < 0 || result === undefined) throw new Error(`missing ${name}`);
      return result;
    };
    await writeFile(plan.receiptPath, JSON.stringify({
      schemaVersion: 2, status: "provider-paused", parent: "codex", provider: "claude", model: "claude-opus-5", effort: "xhigh", mode: "read-only",
      cwd: "/tmp", promptPath: value("--prompt"), outputPath: plan.outputPath, receiptPath: plan.receiptPath, timeoutMs: null,
      managedAttempt: { verified: true, laneId: plan.laneId, attemptId: plan.attemptId, laneFingerprint: value("--lane-fingerprint"), promptSha256: value("--prompt-sha256") },
      providerPause: { kind: "claude-session-limit" },
    }));
    expect(await store.lanes.tick()).toEqual([]);
    const registry = JSON.parse(await readFile(join(directory, "provider-lanes", "registry.json"), "utf8"));
    const attempt = registry.lanes[0].attempts.at(-1);
    expect(attempt.kind).toBe("provider-paused");
    expect(Date.parse(attempt.nextAttemptAt) - Date.parse(attempt.observedAt)).toBe(1_800_000);
  });

  it("snapshots prompts and rejects a changed registration policy", async () => {
    const { directory, store, prompt } = await fixture();
    await register(store, prompt);
    await writeFile(prompt, "changed source\n");
    const snapshot = await readFile(join(directory, "provider-lanes", "claude-review", "prompt.md"), "utf8");
    expect(snapshot).toBe("mandatory claude review\n");
    await expect(store.lanes.register({ laneId: "claude-review", unitId: "unit", parent: "codex", provider: "claude", model: "claude-opus-5", effort: "high", mode: "read-only", promptPath: prompt, cwd: "/tmp" })).rejects.toThrow("different immutable specification");
  });
});
