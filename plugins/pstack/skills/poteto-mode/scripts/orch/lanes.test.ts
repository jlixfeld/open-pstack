import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "../runner/cli.ts";
import { invocationCommand, preflightCommand } from "../runner/commands.ts";
import { sha256Hex } from "../runner/identity.ts";
import { buildReceipt } from "../runner/receipt.ts";
import { runLane } from "../runner/run.ts";
import type {
  FailureReceiptStatus,
  RunnerOptions,
  RunnerReceiptV2,
} from "../runner/types.ts";
import {
  DEFAULT_RETRY_INTERVAL_SECONDS,
  type LaunchPlan,
  type RegisterParams,
} from "./lanes.ts";
import { parseLaneRegistry } from "./lane-registry.ts";
import { openStore, type Store } from "./store.ts";

const directories: string[] = [];
const stores: Store[] = [];
const START = Date.parse("2026-09-04T12:00:00.000Z");
const COMPLETE_OUTPUT = "review complete\n";

interface Fixture {
  readonly directory: string;
  readonly store: Store;
  readonly prompt: string;
  readonly setNow: (value: number) => void;
}

async function fixture(promptContents: string | Uint8Array = "mandatory review\n"): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "orch-lanes-"));
  directories.push(directory);
  let now = START;
  const store = openStore(directory, { now: () => now });
  stores.push(store);
  await store.init();
  await store.units.add({ id: "unit", track: "test" });
  const prompt = join(directory, "source-prompt.md");
  await writeFile(prompt, promptContents);
  return {
    directory,
    store,
    prompt,
    setNow: (value) => {
      now = value;
    },
  };
}

function registration(
  promptPath: string,
  changes: Partial<RegisterParams> = {}
): RegisterParams {
  return {
    laneId: "claude-review",
    unitId: "unit",
    parent: "codex",
    provider: "claude",
    model: "claude-opus-5",
    effort: "xhigh",
    mode: "read-only",
    promptPath,
    cwd: "/tmp",
    ...changes,
  };
}

function runnerOptions(plan: LaunchPlan): RunnerOptions {
  const result = parseArgs(plan.argv);
  if (result === null) throw new Error("launch plan rendered runner help");
  return result;
}

function processDetails(
  input: RunnerOptions,
  completedAt: number,
  exitCode: number | null = 0
) {
  const executable = `/usr/local/bin/${input.provider}`;
  const startedAt = completedAt - 1_250;
  return {
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    elapsedMs: completedAt - startedAt,
    executable,
    preflight: {
      argv: [executable, ...preflightCommand(input.provider).args],
      status: "passed" as const,
      evidence: "authenticated",
    },
    argv: [executable, ...invocationCommand(input).args],
    exitCode,
    signal: null,
  };
}

function verifiedAttempt(input: RunnerOptions) {
  if (input.managedAttempt === null) throw new Error("plan is not managed");
  return { ...input.managedAttempt, verified: true as const };
}

function completeReceipt(
  plan: LaunchPlan,
  completedAt: number = START + 5_000
): RunnerReceiptV2 {
  const input = runnerOptions(plan);
  const modelProof = input.provider === "codex"
    ? {
        provider: "codex" as const,
        reportedModel: null,
        modelVerified: false as const,
        modelEvidence: "pinned-argv" as const,
      }
    : {
        provider: input.provider,
        reportedModel: `${input.model}-20260901`,
        modelVerified: true as const,
        modelEvidence: "provider-report" as const,
      };
  return buildReceipt(input, {
    ...processDetails(input, completedAt),
    status: "complete",
    modelProof,
    managedAttempt: verifiedAttempt(input),
    outputSha256: sha256Hex(COMPLETE_OUTPUT),
    sessionId: "session-1",
    usage: { inputTokens: 10, outputTokens: 20 },
    costUsd: 0.25,
  });
}

function pauseReceipt(
  plan: LaunchPlan,
  observedAt: number = START + 5_000
): RunnerReceiptV2 {
  const input = runnerOptions(plan);
  if (input.provider !== "claude") throw new Error("only Claude pauses");
  const message = "You've hit your session limit - resets later";
  return buildReceipt(input, {
    ...processDetails(input, observedAt, 1),
    status: "provider-paused",
    provider: "claude",
    reportedModel: `${input.model}-20260901`,
    managedAttempt: verifiedAttempt(input),
    sessionId: "session-1",
    usage: { inputTokens: 10 },
    costUsd: 0.25,
    providerPause: {
      kind: "claude-session-limit",
      terminalReason: "api_error",
      apiStatus: 429,
      observedAt: new Date(observedAt).toISOString(),
      message,
      resetEvidence: message,
    },
  });
}

function failureReceipt(
  plan: LaunchPlan,
  status: FailureReceiptStatus = "child-failed",
  completedAt: number = START + 5_000
): RunnerReceiptV2 {
  const input = runnerOptions(plan);
  return buildReceipt(input, {
    ...processDetails(input, completedAt, status === "malformed-output" ? 0 : 1),
    status,
    provider: input.provider,
    managedAttempt: verifiedAttempt(input),
    error: { message: "child exited with status 1", evidence: "boom" },
  });
}

function identityFailureReceipt(plan: LaunchPlan): RunnerReceiptV2 {
  const input = runnerOptions(plan);
  if (input.managedAttempt === null) throw new Error("plan is not managed");
  return buildReceipt(input, {
    ...processDetails(input, START + 5_000, null),
    executable: null,
    preflight: {
      argv: ["claude", ...preflightCommand("claude").args],
      status: "not-run",
      evidence: "",
    },
    argv: ["claude", ...invocationCommand(input).args],
    status: "child-failed",
    provider: input.provider,
    managedAttempt: {
      ...input.managedAttempt,
      verified: false,
      reason: "prompt-digest-mismatch",
    },
    error: {
      message: "launcher failed after reserving output paths",
      evidence: "managed attempt identity could not be verified",
    },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function finishComplete(plan: LaunchPlan, completedAt?: number): Promise<void> {
  await writeFile(plan.outputPath, COMPLETE_OUTPUT);
  await writeJson(plan.receiptPath, completeReceipt(plan, completedAt));
}

async function finishPause(plan: LaunchPlan, observedAt?: number): Promise<void> {
  await writeJson(plan.receiptPath, pauseReceipt(plan, observedAt));
}

async function finishFailure(plan: LaunchPlan): Promise<void> {
  await writeJson(plan.receiptPath, failureReceipt(plan));
}

async function tickPlans(store: Store): Promise<readonly LaunchPlan[]> {
  return (await store.lanes.tick()).plans;
}

async function registry(directory: string): Promise<any> {
  return JSON.parse(
    await readFile(join(directory, "provider-lanes", "registry.json"), "utf8")
  );
}

async function expectRegistryRoundTrip(
  directory: string,
  unitIds: readonly string[] = ["unit"]
): Promise<any> {
  const value = await registry(directory);
  expect(parseLaneRegistry(value, directory, new Set(unitIds))).toEqual(value);
  return value;
}

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) await store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("managed provider lane registration", () => {
  it("rejects a zero-byte prompt before creating a snapshot or obligation", async () => {
    const { directory, store, prompt } = await fixture("");

    await expect(store.lanes.register(registration(prompt))).rejects.toThrow(
      "prompt must not be empty"
    );

    expect((await readdir(join(directory, "provider-lanes"))).sort()).toEqual([
      "registry.json",
    ]);
    expect((await registry(directory)).lanes).toEqual([]);
    expect(await store.lanes.check("unit")).toEqual({
      unitId: "unit",
      ready: true,
      blockingLaneIds: [],
    });
    expect(await store.units.set({ id: "unit", state: "done" })).toMatchObject({
      state: "done",
    });
  });

  it("snapshots exact bytes privately before returning the first launch plan", async () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x61, 0x0a]);
    const { directory, store, prompt } = await fixture(bytes);
    const lane = await store.lanes.register(registration(prompt));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");

    expect([...(await readFile(lane.spec.promptPath))]).toEqual([...bytes]);
    expect((await stat(lane.spec.promptPath)).mode & 0o777).toBe(0o600);
    expect(lane.spec.retryIntervalMs).toBe(
      DEFAULT_RETRY_INTERVAL_SECONDS * 1_000
    );
    expect(plan.command).toBe(
      resolve(import.meta.dir, "..", "runner", "pstack-runner")
    );
    expect(plan.argv).toEqual([
      "--parent", lane.spec.parent,
      "--provider", lane.spec.provider,
      "--model", lane.spec.model,
      "--effort", lane.spec.effort,
      "--mode", lane.spec.mode,
      "--prompt", lane.spec.promptPath,
      "--cwd", lane.spec.cwd,
      "--output", plan.outputPath,
      "--receipt", plan.receiptPath,
      "--lane-id", lane.spec.laneId,
      "--attempt-id", plan.attemptId,
      "--lane-fingerprint", lane.spec.laneFingerprint,
      "--prompt-sha256", lane.spec.promptSha256,
    ]);
    expect((await registry(directory)).lanes).toHaveLength(1);
  });

  it("makes identical registration idempotent and isolates the snapshot from source changes", async () => {
    const { directory, store, prompt } = await fixture("original bytes\n");
    const first = await store.lanes.register(registration(prompt));
    const second = await store.lanes.register(registration(prompt));
    expect(second).toEqual(first);
    expect((await registry(directory)).lanes).toHaveLength(1);

    await writeFile(prompt, "changed source\n");
    expect(await readFile(first.spec.promptPath, "utf8")).toBe("original bytes\n");
  });

  it("repairs a missing immutable snapshot from matching registration bytes", async () => {
    const { directory, store, prompt } = await fixture("original bytes\n");
    const first = await store.lanes.register(registration(prompt));
    await rm(first.spec.promptPath);

    const repaired = await store.lanes.register(registration(prompt));

    expect(repaired).toEqual(first);
    expect(await readFile(first.spec.promptPath, "utf8")).toBe("original bytes\n");
    expect((await stat(first.spec.promptPath)).mode & 0o777).toBe(0o600);
    expect((await registry(directory)).lanes).toEqual([first]);
  });

  it("does not recreate a missing immutable snapshot from changed source bytes", async () => {
    const { directory, store, prompt } = await fixture("original bytes\n");
    const first = await store.lanes.register(registration(prompt));
    await rm(first.spec.promptPath);
    await writeFile(prompt, "changed source\n");

    await expect(store.lanes.register(registration(prompt))).rejects.toThrow(
      "different immutable specification"
    );

    expect(await stat(first.spec.promptPath).catch(() => null)).toBeNull();
    expect((await registry(directory)).lanes).toEqual([first]);
  });

  it("rejects changed immutable specs and every runner-invalid managed route", async () => {
    const { directory, store, prompt } = await fixture();
    await store.lanes.register(registration(prompt));
    await expect(
      store.lanes.register(registration(prompt, { effort: "high" }))
    ).rejects.toThrow("different immutable specification");

    const invalidRoutes: Array<readonly [string, Partial<RegisterParams>]> = [
      ["native route", { laneId: "native", parent: "claude" }],
      ["managed Grok", {
        laneId: "grok",
        provider: "grok",
        model: "grok-4.6",
        effort: "xhigh",
      }],
      ["wrong provider model", { laneId: "wrong-model", model: "gpt-5.6-sol" }],
      ["unsupported effort", { laneId: "wrong-effort", effort: "ultra" }],
      ["missing cwd", { laneId: "missing-cwd", cwd: join(directory, "missing") }],
      ["file cwd", { laneId: "file-cwd", cwd: prompt }],
    ];
    for (const [label, changes] of invalidRoutes) {
      await expect(store.lanes.register(registration(prompt, changes))).rejects.toThrow();
      expect((await registry(directory)).lanes.map((lane: any) => lane.spec.laneId)).not.toContain(label);
    }
  });

  it("rejects unsafe bounded ids before deriving any path", async () => {
    const { store, prompt } = await fixture();
    for (const laneId of ["../../escape", "bad.name", "line\nbreak", "a".repeat(65), "-bad"]) {
      await expect(
        store.lanes.register(registration(prompt, { laneId }))
      ).rejects.toThrow("must match");
    }
    await store.units.add({ id: "../unit", track: "test" });
    await expect(
      store.lanes.register(registration(prompt, { laneId: "safe", unitId: "../unit" }))
    ).rejects.toThrow("must match");
  });

  it("rejects uppercase lane ids without overwriting a lowercase snapshot", async () => {
    const { directory, store, prompt } = await fixture("lowercase snapshot\n");
    const lane = await store.lanes.register(registration(prompt, {
      laneId: "review",
    }));
    const before = await readFile(lane.spec.promptPath);
    await writeFile(prompt, "uppercase replacement\n");

    await expect(
      store.lanes.register(registration(prompt, { laneId: "Review" }))
    ).rejects.toThrow("lowercase");
    await expect(store.lanes.retry("Review")).rejects.toThrow("lowercase");
    await expect(store.lanes.release({
      laneId: "Review",
      attemptId: "attempt",
      reason: "retained pid 12 is dead",
    })).rejects.toThrow("lowercase");

    expect(await readFile(lane.spec.promptPath)).toEqual(before);
    expect((await registry(directory)).lanes).toHaveLength(1);
    expect((await readdir(join(directory, "provider-lanes"))).sort()).toEqual([
      "registry.json",
      "review",
    ]);
  });

  it("records an explicit configured retry interval and timeout in the exact argv", async () => {
    const { store, prompt } = await fixture();
    const lane = await store.lanes.register(registration(prompt, {
      intervalSeconds: 3_600,
      timeoutSeconds: 5_400,
    }));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    expect(lane.spec.retryIntervalMs).toBe(3_600_000);
    expect(lane.spec.timeoutMs).toBe(5_400_000);
    expect(plan.argv.slice(-2)).toEqual(["--timeout", "5400"]);
    await expect(store.lanes.register(registration(prompt, {
      laneId: "too-soon",
      intervalSeconds: DEFAULT_RETRY_INTERVAL_SECONDS - 1,
    }))).rejects.toThrow("at least 1800");
  });
});

describe("managed provider lane scheduling", () => {
  it("settles a canonical completion when the runner clock is behind the clamped claim", async () => {
    const { directory, store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt));

    setNow(START - 5_000);
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    await finishComplete(plan, START - 1_000);

    expect(await tickPlans(store)).toEqual([]);
    expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe(
      "complete"
    );
    expect(await store.lanes.check("unit")).toEqual({
      unitId: "unit",
      ready: true,
      blockingLaneIds: [],
    });
  });

  it("clamps claim, release, and retry transitions when the wall clock rolls back", async () => {
    const { directory, store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt));
    await expectRegistryRoundTrip(directory);

    setNow(START - 5_000);
    const [claimed] = await tickPlans(store);
    if (claimed === undefined) throw new Error("missing claimed plan");
    let value = await expectRegistryRoundTrip(directory);
    expect(value.lanes[0].attempts.at(-1).claimedAt).toBe(
      new Date(START).toISOString()
    );

    setNow(START - 10_000);
    await store.lanes.release({
      laneId: claimed.laneId,
      attemptId: claimed.attemptId,
      reason: "retained pid 12 is dead",
    });
    value = await expectRegistryRoundTrip(directory);
    expect(value.lanes[0].attempts.at(-1).interruptedAt).toBe(
      new Date(START).toISOString()
    );

    setNow(START - 15_000);
    await store.lanes.retry(claimed.laneId);
    value = await expectRegistryRoundTrip(directory);
    expect(value.lanes[0].attempts.at(-1).claimedAt).toBe(
      new Date(START).toISOString()
    );
  });

  it("clamps an explicit retry to a runner failure transition after clock rollback", async () => {
    const { directory, store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    await finishFailure(plan);

    setNow(START - 5_000);
    expect(await tickPlans(store)).toEqual([]);
    let value = await expectRegistryRoundTrip(directory);
    expect(value.lanes[0].attempts.at(-1).completedAt).toBe(
      new Date(START + 5_000).toISOString()
    );

    await store.lanes.retry(plan.laneId);
    value = await expectRegistryRoundTrip(directory);
    expect(value.lanes[0].attempts.at(-1).claimedAt).toBe(
      new Date(START + 5_000).toISOString()
    );
  });

  it("replays the same unreserved plan after restart", async () => {
    const { directory, store, prompt } = await fixture();
    await store.lanes.register(registration(prompt));
    const first = await tickPlans(store);
    await store.close();

    const restarted = openStore(directory, { now: () => START });
    stores.push(restarted);
    expect(await tickPlans(restarted)).toEqual(first);
  });

  it("reports held partial artifacts without relaunching or yielding the provider", async () => {
    const { directory, store, prompt } = await fixture();
    await store.units.add({ id: "codex-unit", track: "test" });
    await store.units.add({ id: "claude-next-unit", track: "test" });
    await store.units.add({ id: "codex-next-unit", track: "test" });
    await store.lanes.register(registration(prompt));
    await store.lanes.register(registration(prompt, {
      laneId: "codex-review",
      unitId: "codex-unit",
      parent: "claude",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
    }));
    const plans = await tickPlans(store);
    expect(plans).toHaveLength(2);
    await writeFile(plans[0]!.outputPath, "reserved");
    await writeFile(plans[1]!.receiptPath, "{");
    await store.lanes.register(registration(prompt, {
      laneId: "claude-next",
      unitId: "claude-next-unit",
    }));
    await store.lanes.register(registration(prompt, {
      laneId: "codex-next",
      unitId: "codex-next-unit",
      parent: "claude",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
    }));

    expect(await store.lanes.tick()).toEqual({
      plans: [],
      stalledLanes: [
        {
          laneId: "claude-review",
          reason: "lane claude-review claim has an output artifact without a receipt artifact; provider claude remains occupied",
        },
        {
          laneId: "codex-review",
          reason: "lane codex-review claim has a receipt artifact without an output artifact; provider codex remains occupied",
        },
      ],
    });
    const value = await registry(directory);
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "claude-next")
      .attempts.at(-1).kind).toBe("registered");
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "codex-next")
      .attempts.at(-1).kind).toBe("registered");
  });

  it("keeps provider-wide single-flight across duplicate wakes", async () => {
    const { store, prompt } = await fixture();
    await store.units.add({ id: "unit-two", track: "test" });
    await store.lanes.register(registration(prompt, { laneId: "first" }));
    await store.lanes.register(registration(prompt, {
      laneId: "second",
      unitId: "unit-two",
    }));

    const firstWake = await tickPlans(store);
    expect(firstWake).toHaveLength(1);
    expect(firstWake[0]?.laneId).toBe("first");
    expect(await tickPlans(store)).toEqual(firstWake);
  });

  it("schedules from observedAt, does not retry early, and reuses the due probe plan", async () => {
    const { directory, store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt));
    const [first] = await tickPlans(store);
    if (first === undefined) throw new Error("missing plan");
    const observedAt = START + 5_000;
    await finishPause(first, observedAt);
    setNow(START + 20 * 60_000);
    expect(await tickPlans(store)).toEqual([]);

    let paused = (await registry(directory)).lanes[0].attempts.at(-1);
    expect(paused).toMatchObject({
      kind: "provider-paused",
      observedAt: new Date(observedAt).toISOString(),
      nextAttemptAt: new Date(observedAt + 1_800_000).toISOString(),
    });
    setNow(observedAt + 1_800_000 - 1);
    expect(await tickPlans(store)).toEqual([]);
    expect((await registry(directory)).lanes[0].attempts.at(-1)).toEqual(paused);

    setNow(observedAt + 1_800_000);
    const [due] = await tickPlans(store);
    if (due === undefined) throw new Error("missing due plan");
    expect(due.laneId).toBe(first.laneId);
    expect(due.attemptId).not.toBe(first.attemptId);
    expect(due.outputPath).not.toBe(first.outputPath);
    expect(due.receiptPath).not.toBe(first.receiptPath);
    expect(await tickPlans(store)).toEqual([due]);
    paused = (await registry(directory)).lanes[0].attempts.at(-2);
    expect(paused.nextAttemptAt).toBe(new Date(observedAt + 1_800_000).toISOString());
  });

  it("applies the configured interval from the receipt observation", async () => {
    const { directory, store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt, { intervalSeconds: 3_600 }));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    const observedAt = START + 5_000;
    await finishPause(plan, observedAt);
    setNow(observedAt + 30_000);
    await tickPlans(store);
    const paused = (await registry(directory)).lanes[0].attempts.at(-1);
    expect(Date.parse(paused.nextAttemptAt) - Date.parse(paused.observedAt)).toBe(3_600_000);
  });

  it("blocks explicit retry while a sibling is claimed or provider-paused", async () => {
    const { store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt, { laneId: "failed" }));
    const [failed] = await tickPlans(store);
    if (failed === undefined) throw new Error("missing plan");
    await finishFailure(failed);
    setNow(START + 5_000);
    await tickPlans(store);

    await store.units.add({ id: "unit-two", track: "test" });
    await store.lanes.register(registration(prompt, {
      laneId: "probe",
      unitId: "unit-two",
    }));
    const [probe] = await tickPlans(store);
    if (probe === undefined) throw new Error("missing probe");
    await expect(store.lanes.retry("failed")).rejects.toThrow(
      "provider claude is occupied by lane probe"
    );

    await finishPause(probe, START + 10_000);
    setNow(START + 10_000);
    await tickPlans(store);
    await expect(store.lanes.retry("failed")).rejects.toThrow(
      "provider claude is occupied by lane probe"
    );
    setNow(START + 10_000 + 1_800_000);
    expect((await tickPlans(store))[0]?.laneId).toBe("probe");
  });

  it("skips registered lanes on terminal reconciliation units without clearing their gates", async () => {
    for (const state of ["abandoned", "zombie-reconciled"] as const) {
      const { directory, store, prompt } = await fixture();
      await store.lanes.register(registration(prompt));
      await store.units.set({ id: "unit", state });

      expect(await tickPlans(store)).toEqual([]);
      expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe(
        "registered"
      );
      expect(await store.lanes.check("unit")).toEqual({
        unitId: "unit",
        ready: false,
        blockingLaneIds: ["claude-review"],
      });
      await expect(
        store.units.set({ id: "unit", state: "done" })
      ).rejects.toThrow("incomplete managed provider lanes");
    }
  });

  it("lets a live sibling bypass a due pause owned by a terminal unit", async () => {
    const { directory, store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt, { laneId: "dead-pause" }));
    const [first] = await tickPlans(store);
    if (first === undefined) throw new Error("missing first plan");
    await finishPause(first);
    setNow(START + 5_000);
    await tickPlans(store);
    await store.units.set({ id: "unit", state: "abandoned" });

    await store.units.add({ id: "live-unit", track: "test" });
    await store.lanes.register(registration(prompt, {
      laneId: "live-review",
      unitId: "live-unit",
    }));
    setNow(START + 5_000 + 60_000);
    expect(await tickPlans(store)).toEqual([]);

    setNow(START + 5_000 + 1_800_000);

    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing live sibling plan");
    expect(plan.laneId).toBe("live-review");
    const value = await registry(directory);
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "dead-pause")
      .attempts.at(-1).kind).toBe("provider-paused");
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "live-review")
      .attempts.at(-1).kind).toBe("claimed");

    await finishComplete(plan);
    setNow(START + 5_000 + 1_800_001);
    expect(await tickPlans(store)).toEqual([]);
    expect((await registry(directory)).lanes.find(
      (lane: any) => lane.spec.laneId === "dead-pause"
    ).attempts.at(-1).kind).toBe("provider-paused");
  });

  it("replays a live sibling claim after restart and rollback past an expired terminal pause", async () => {
    const { directory, store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt, { laneId: "dead-pause" }));
    const [first] = await tickPlans(store);
    if (first === undefined) throw new Error("missing first plan");
    await finishPause(first);
    setNow(START + 5_000);
    await tickPlans(store);
    await store.units.set({ id: "unit", state: "abandoned" });

    await store.units.add({ id: "live-unit", track: "test" });
    await store.lanes.register(registration(prompt, {
      laneId: "live-review",
      unitId: "live-unit",
    }));
    setNow(START + 5_000 + 1_800_000);
    const [live] = await tickPlans(store);
    if (live === undefined) throw new Error("missing live sibling plan");

    await store.close();
    const restarted = openStore(directory, {
      now: () => START + 5_000 + 60_000,
    });
    stores.push(restarted);

    expect(await tickPlans(restarted)).toEqual([live]);
    const value = await registry(directory);
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "dead-pause")
      .attempts.at(-1).kind).toBe("provider-paused");
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "live-review")
      .attempts.at(-1)).toMatchObject({
        kind: "claimed",
        attemptId: live.attemptId,
      });

    await restarted.units.add({ id: "later-unit", track: "test" });
    await restarted.lanes.register(registration(prompt, {
      laneId: "later-review",
      unitId: "later-unit",
    }));
    await finishComplete(live, START + 5_000 + 1_800_001);

    const [later] = await tickPlans(restarted);
    expect(later?.laneId).toBe("later-review");
  });

  it("rejects retry on terminal units without starving a live sibling", async () => {
    for (const state of ["abandoned", "zombie-reconciled"] as const) {
      const { directory, store, prompt } = await fixture();
      await store.lanes.register(registration(prompt, { laneId: "dead-review" }));
      const [failed] = await tickPlans(store);
      if (failed === undefined) throw new Error("missing failed plan");
      await finishFailure(failed);
      await store.units.set({ id: "unit", state });

      await store.units.add({ id: "live-unit", track: "test" });
      await store.lanes.register(registration(prompt, {
        laneId: "live-review",
        unitId: "live-unit",
      }));

      await expect(store.lanes.retry("dead-review")).rejects.toThrow(
        `unit unit is ${state}`
      );
      const [live] = await tickPlans(store);
      expect(live?.laneId).toBe("live-review");

      const value = await registry(directory);
      expect(value.lanes.find((lane: any) => lane.spec.laneId === "dead-review")
        .attempts.at(-1).kind).toBe("failed");
      expect(value.lanes.find((lane: any) => lane.spec.laneId === "live-review")
        .attempts.at(-1).kind).toBe("claimed");
    }
  });

  it("keeps a terminal unit's claimed child provider-occupying", async () => {
    const { directory, store, prompt } = await fixture();
    await store.lanes.register(registration(prompt, { laneId: "dead-claim" }));
    const [claimed] = await tickPlans(store);
    if (claimed === undefined) throw new Error("missing claimed plan");
    await store.units.set({ id: "unit", state: "zombie-reconciled" });
    await store.units.add({ id: "live-unit", track: "test" });
    await store.lanes.register(registration(prompt, {
      laneId: "live-review",
      unitId: "live-unit",
    }));

    expect(await store.lanes.tick()).toEqual({
      plans: [],
      stalledLanes: [{
        laneId: "dead-claim",
        reason: "lane dead-claim is claimed without launcher artifacts on terminal unit unit; provider claude remains occupied",
      }],
    });
    const value = await registry(directory);
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "dead-claim")
      .attempts.at(-1).kind).toBe("claimed");
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "live-review")
      .attempts.at(-1).kind).toBe("registered");
  });

  it("holds and reports a claim after its immutable prompt or cwd is lost", async () => {
    for (const corruption of [
      "missing-prompt",
      "changed-prompt",
      "empty-prompt",
      "missing-cwd",
      "file-cwd",
    ] as const) {
      const { directory, store, prompt } = await fixture();
      const cwd = join(directory, `cwd-${corruption}`);
      await mkdir(cwd);
      const lane = await store.lanes.register(registration(prompt, { cwd }));
      const [plan] = await tickPlans(store);
      if (plan === undefined) throw new Error(`missing plan for ${corruption}`);

      if (corruption === "missing-prompt") {
        await rm(lane.spec.promptPath);
      } else if (corruption === "changed-prompt") {
        await writeFile(lane.spec.promptPath, "changed\n");
      } else if (corruption === "empty-prompt") {
        await writeFile(lane.spec.promptPath, "");
      } else if (corruption === "missing-cwd") {
        await rm(cwd, { recursive: true });
      } else {
        await rm(cwd, { recursive: true });
        await writeFile(cwd, "not a directory\n");
      }

      if (
        corruption === "missing-prompt" ||
        corruption === "missing-cwd" ||
        corruption === "file-cwd"
      ) {
        await expect(runLane(runnerOptions(plan))).rejects.toThrow();
      }

      expect(await stat(plan.outputPath).catch(() => null)).toBeNull();
      expect(await stat(plan.receiptPath).catch(() => null)).toBeNull();
      const firstTick = await store.lanes.tick();
      expect(firstTick.plans).toEqual([]);
      expect(firstTick.stalledLanes).toEqual([{
        laneId: lane.spec.laneId,
        reason: expect.stringContaining(`lane ${lane.spec.laneId}`),
      }]);
      expect(await store.lanes.tick()).toEqual(firstTick);
      expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe(
        "claimed"
      );
    }
  });

  it("reports one lost-input claim, settles receipts, and continues healthy providers", async () => {
    const { directory, store, prompt } = await fixture();
    const lostCwd = join(directory, "lost-cwd");
    await mkdir(lostCwd);
    await store.units.add({ id: "codex-complete-unit", track: "test" });
    await store.units.add({ id: "codex-next-unit", track: "test" });
    await store.lanes.register(registration(prompt, {
      laneId: "lost-claude",
      cwd: lostCwd,
    }));
    await store.lanes.register(registration(prompt, {
      laneId: "codex-complete",
      unitId: "codex-complete-unit",
      parent: "claude",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
    }));
    await store.lanes.register(registration(prompt, {
      laneId: "codex-next",
      unitId: "codex-next-unit",
      parent: "claude",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
    }));

    const first = await tickPlans(store);
    const lostPlan = first.find((plan) => plan.laneId === "lost-claude");
    const completedPlan = first.find((plan) => plan.laneId === "codex-complete");
    if (lostPlan === undefined || completedPlan === undefined) {
      throw new Error("missing initial provider plans");
    }
    await finishComplete(completedPlan);
    await rm(lostCwd, { recursive: true });

    const result = await store.lanes.tick();

    expect(result.plans.map((plan) => plan.laneId)).toEqual(["codex-next"]);
    expect(result.stalledLanes).toEqual([{
      laneId: "lost-claude",
      reason: "lane lost-claude working directory is missing or is not a directory",
    }]);
    const value = await registry(directory);
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "lost-claude")
      .attempts.at(-1)).toMatchObject({
        kind: "claimed",
        attemptId: lostPlan.attemptId,
      });
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "codex-complete")
      .attempts.at(-1).kind).toBe("complete");
    expect(value.lanes.find((lane: any) => lane.spec.laneId === "codex-next")
      .attempts.at(-1).kind).toBe("claimed");
  });
});

describe("managed provider lane outcomes and gates", () => {
  it("refuses explicit retry for registered and complete lanes", async () => {
    const { store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt));
    await expect(store.lanes.retry("claude-review")).rejects.toThrow(
      "not eligible"
    );

    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    await finishComplete(plan);
    setNow(START + 5_000);
    await tickPlans(store);
    await expect(store.lanes.retry("claude-review")).rejects.toThrow(
      "not eligible"
    );
  });

  it("runs pause to due retry to continuously validated completion", async () => {
    const { store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt));
    const [first] = await tickPlans(store);
    if (first === undefined) throw new Error("missing plan");
    await finishPause(first);
    setNow(START + 5_000);
    await tickPlans(store);
    expect((await store.lanes.check("unit")).blockingLaneIds).toEqual([
      "claude-review",
    ]);

    setNow(START + 5_000 + 1_800_000);
    const [retry] = await tickPlans(store);
    if (retry === undefined) throw new Error("missing retry");
    await finishComplete(retry, START + 5_000 + 1_800_000 + 2_000);
    await tickPlans(store);
    expect(await store.lanes.check("unit")).toEqual({
      unitId: "unit",
      ready: true,
      blockingLaneIds: [],
    });
  });

  it("requires explicit retry for ordinary failure and uses fresh artifacts", async () => {
    const { store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt));
    const [first] = await tickPlans(store);
    if (first === undefined) throw new Error("missing plan");
    await finishFailure(first);
    setNow(START + 5_000);
    expect(await tickPlans(store)).toEqual([]);

    const retry = await store.lanes.retry(first.laneId);
    expect(retry.attemptId).not.toBe(first.attemptId);
    expect(retry.outputPath).not.toBe(first.outputPath);
    expect(retry.receiptPath).not.toBe(first.receiptPath);
  });

  it("settles a valid malformed-output receipt as a failed attempt", async () => {
    const { directory, store, prompt } = await fixture();
    await store.lanes.register(registration(prompt));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    await writeJson(plan.receiptPath, failureReceipt(plan, "malformed-output"));

    expect(await store.lanes.tick()).toEqual({ plans: [], stalledLanes: [] });
    expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe(
      "failed"
    );
  });

  it("holds an identity-failure receipt until authoritative release", async () => {
    const { directory, store, prompt } = await fixture();
    await store.lanes.register(registration(prompt));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    await writeJson(plan.receiptPath, identityFailureReceipt(plan));
    expect(await tickPlans(store)).toEqual([]);
    expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe("claimed");
    expect((await store.lanes.check("unit")).ready).toBe(false);

    await store.lanes.release({
      laneId: plan.laneId,
      attemptId: plan.attemptId,
      reason: "retained pid 12 is dead",
    });
    expect((await store.lanes.retry(plan.laneId)).attemptId).not.toBe(plan.attemptId);
  });

  it("never infers a dead claim and refuses stale release", async () => {
    const { store, prompt, setNow } = await fixture();
    await store.lanes.register(registration(prompt));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    await writeFile(plan.outputPath, "");
    setNow(Date.parse("2036-09-04T12:00:00.000Z"));
    expect(await tickPlans(store)).toEqual([]);
    await expect(store.lanes.release({
      laneId: plan.laneId,
      attemptId: "stale-attempt",
      reason: "dead pid 12",
    })).rejects.toThrow("does not have claimed attempt");
    await store.lanes.release({
      laneId: plan.laneId,
      attemptId: plan.attemptId,
      reason: "dead pid 12",
    });
  });

  it("reconciles first and refuses release after complete or pause", async () => {
    for (const terminal of ["complete", "pause"] as const) {
      const { store, prompt, setNow } = await fixture();
      await store.lanes.register(registration(prompt));
      const [plan] = await tickPlans(store);
      if (plan === undefined) throw new Error("missing plan");
      if (terminal === "complete") await finishComplete(plan);
      else await finishPause(plan);
      setNow(START + 5_000);
      await expect(store.lanes.release({
        laneId: plan.laneId,
        attemptId: plan.attemptId,
        reason: "dead pid 12",
      })).rejects.toThrow("does not have claimed attempt");
    }
  });

  it("blocks advancing states but permits metadata and terminal reconciliation", async () => {
    const { store, prompt } = await fixture();
    await store.lanes.register(registration(prompt));
    await expect(store.units.set({ id: "unit", state: "done" })).rejects.toThrow(
      "incomplete managed provider lanes"
    );
    expect(await store.units.set({
      id: "unit",
      state: "pending",
      branch: "feature/review",
    })).toMatchObject({ state: "pending", branch: "feature/review" });
    expect(await store.units.set({ id: "unit", state: "abandoned" })).toMatchObject({
      state: "abandoned",
    });
    expect(await store.units.set({ id: "unit", state: "zombie-reconciled" })).toMatchObject({
      state: "zombie-reconciled",
    });
    await expect(store.units.set({ id: "unit", state: "done" })).rejects.toThrow(
      "incomplete managed provider lanes"
    );
  });

  it("rejects unknown unit checks", async () => {
    const { store } = await fixture();
    await expect(store.lanes.check("typo-unit")).rejects.toThrow("not found");
  });

  it("revalidates prompt, receipt, and output bytes after completion", async () => {
    const { store, prompt, setNow } = await fixture();
    const lane = await store.lanes.register(registration(prompt));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    await finishComplete(plan);
    setNow(START + 5_000);
    await tickPlans(store);
    expect((await store.lanes.check("unit")).ready).toBe(true);

    const originalPrompt = await readFile(lane.spec.promptPath);
    const originalReceipt = await readFile(plan.receiptPath);
    const originalOutput = await readFile(plan.outputPath);
    for (const [path, changed, original] of [
      [lane.spec.promptPath, "changed prompt", originalPrompt],
      [plan.receiptPath, `${originalReceipt.toString()} `, originalReceipt],
      [plan.outputPath, "changed output", originalOutput],
    ] as const) {
      await writeFile(path, changed);
      expect((await store.lanes.check("unit")).ready).toBe(false);
      await writeFile(path, original);
      expect((await store.lanes.check("unit")).ready).toBe(true);
    }
  });

  it("holds a complete receipt when output changes before first reconciliation", async () => {
    const { directory, store, prompt } = await fixture();
    await store.lanes.register(registration(prompt));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    await finishComplete(plan);
    await writeFile(plan.outputPath, "tampered before reconciliation\n");

    expect(await tickPlans(store)).toEqual([]);
    expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe(
      "claimed"
    );
    expect((await store.lanes.check("unit")).ready).toBe(false);

    await writeFile(plan.outputPath, COMPLETE_OUTPUT);
    expect(await tickPlans(store)).toEqual([]);
    expect((await store.lanes.check("unit")).ready).toBe(true);
  });

  it("accepts Claude build-qualified proof and Codex pinned-argv proof", async () => {
    const { store, prompt, setNow } = await fixture();
    await store.units.add({ id: "codex-unit", track: "test" });
    await store.lanes.register(registration(prompt));
    await store.lanes.register(registration(prompt, {
      laneId: "codex-review",
      unitId: "codex-unit",
      parent: "claude",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
    }));
    const plans = await tickPlans(store);
    for (const plan of plans) await finishComplete(plan);
    setNow(START + 5_000);
    await tickPlans(store);
    expect((await store.lanes.check("unit")).ready).toBe(true);
    expect((await store.lanes.check("codex-unit")).ready).toBe(true);
  });
});

describe("managed receipt rejection", () => {
  it("holds every partial, legacy, unmanaged, mismatched, or impossible receipt", async () => {
    const cases: Array<readonly [string, (valid: any) => unknown]> = [
      ["partial", () => ({ schemaVersion: 2, status: "complete" })],
      ["v1", (valid) => ({ ...valid, schemaVersion: 1 })],
      ["unmanaged", (valid) => ({ ...valid, managedAttempt: null })],
      ["unknown status", (valid) => ({ ...valid, status: "future" })],
      ["wrong parent", (valid) => ({ ...valid, parent: "claude" })],
      ["wrong cwd", (valid) => ({ ...valid, cwd: "/" })],
      ["wrong prompt path", (valid) => ({ ...valid, promptPath: "/tmp/other" })],
      ["wrong output path", (valid) => ({ ...valid, outputPath: "/tmp/other" })],
      ["wrong receipt path", (valid) => ({ ...valid, receiptPath: "/tmp/other" })],
      ["wrong timeout", (valid) => ({ ...valid, timeoutMs: 1_000 })],
      ["wrong lane", (valid) => ({
        ...valid,
        managedAttempt: { ...valid.managedAttempt, laneId: "other" },
      })],
      ["wrong attempt", (valid) => ({
        ...valid,
        managedAttempt: { ...valid.managedAttempt, attemptId: "other" },
      })],
      ["wrong fingerprint", (valid) => ({
        ...valid,
        managedAttempt: { ...valid.managedAttempt, laneFingerprint: "b".repeat(64) },
      })],
      ["wrong digest", (valid) => ({
        ...valid,
        managedAttempt: { ...valid.managedAttempt, promptSha256: "b".repeat(64) },
      })],
      ["wrong argv", (valid) => ({ ...valid, argv: ["claude", "--wrong"] })],
      ["invalid preflight", (valid) => ({
        ...valid,
        preflight: { ...valid.preflight, status: "not-run" },
      })],
      ["invalid timing", (valid) => ({ ...valid, elapsedMs: valid.elapsedMs + 1 })],
      ["invalid error", (valid) => ({ ...valid, error: {} })],
      ["invalid pause field", (valid) => ({ ...valid, providerPause: {} })],
      ["invalid model proof", (valid) => ({ ...valid, reportedModel: "claude-opus-4" })],
      ["extra field", (valid) => ({ ...valid, forged: true })],
    ];

    for (const [label, mutate] of cases) {
      const { directory, store, prompt } = await fixture();
      await store.lanes.register(registration(prompt));
      const [plan] = await tickPlans(store);
      if (plan === undefined) throw new Error(`missing plan for ${label}`);
      await writeFile(plan.outputPath, "candidate output\n");
      await writeJson(plan.receiptPath, mutate(completeReceipt(plan)));
      expect(await tickPlans(store)).toEqual([]);
      expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe("claimed");
      expect((await store.lanes.check("unit")).blockingLaneIds).toEqual([
        "claude-review",
      ]);
    }
  });

  it("holds malformed JSON and valid completion with missing or empty output", async () => {
    for (const output of [null, ""] as const) {
      const { directory, store, prompt } = await fixture();
      await store.lanes.register(registration(prompt));
      const [plan] = await tickPlans(store);
      if (plan === undefined) throw new Error("missing plan");
      if (output !== null) await writeFile(plan.outputPath, output);
      await writeJson(plan.receiptPath, completeReceipt(plan));
      expect(await tickPlans(store)).toEqual([]);
      expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe("claimed");
    }

    const { directory, store, prompt } = await fixture();
    await store.lanes.register(registration(prompt));
    const [plan] = await tickPlans(store);
    if (plan === undefined) throw new Error("missing plan");
    await writeFile(plan.receiptPath, "{");
    expect(await tickPlans(store)).toEqual([]);
    expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe("claimed");
  });

  it("holds forged pause metadata and malformed failure receipts", async () => {
    for (const kind of ["pause", "failure"] as const) {
      const { directory, store, prompt } = await fixture();
      await store.lanes.register(registration(prompt));
      const [plan] = await tickPlans(store);
      if (plan === undefined) throw new Error("missing plan");
      const receipt = kind === "pause" ? pauseReceipt(plan) : failureReceipt(plan);
      const invalid = kind === "pause"
        ? { ...receipt, providerPause: { kind: "claude-session-limit" } }
        : { ...receipt, error: null };
      await writeJson(plan.receiptPath, invalid);
      expect(await tickPlans(store)).toEqual([]);
      expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe("claimed");
    }

    for (const receiptFor of [pauseReceipt, failureReceipt] as const) {
      const { directory, store, prompt } = await fixture();
      await store.lanes.register(registration(prompt));
      const [plan] = await tickPlans(store);
      if (plan === undefined) throw new Error("missing plan");
      await writeFile(plan.outputPath, "unexpected output reservation");
      await writeJson(plan.receiptPath, receiptFor(plan));
      expect(await tickPlans(store)).toEqual([]);
      expect((await registry(directory)).lanes[0].attempts.at(-1).kind).toBe("claimed");
    }
  });
});
