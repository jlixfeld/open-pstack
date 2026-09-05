import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { invocationCommand, preflightCommand } from "./commands.ts";
import { laneFingerprint, sha256Hex } from "./identity.ts";
import { parseRunnerReceipt } from "./receipt.ts";
import { childEnvironment, runLane } from "./run.ts";
import { main } from "./cli.ts";
import type { Provider, RunnerOptions, RunnerReceiptV2 } from "./types.ts";

let scratch = "";
let bin = "";
let previousPath: string | undefined;

const fake = `#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const name = process.argv[1].split("/").at(-1);
const isPreflight =
  (name === "claude" && args[0] === "auth") ||
  (name === "codex" && args[0] === "login") ||
  (name === "grok" && args[0] === "models");
const stage = isPreflight ? "preflight" : "model";
const startedPath = isPreflight
  ? process.env.FAKE_PREFLIGHT_STARTED_PATH
  : process.env.FAKE_MODEL_STARTED_PATH;
if (startedPath) writeFileSync(startedPath, String(process.pid));
const cancelStage = process.env.FAKE_CANCEL_STAGE ??
  (process.env.FAKE_CANCEL === "1" ? "model" : "");
if (cancelStage === stage) {
  const stop = (signal) => {
    writeFileSync(process.env.FAKE_TERMINATED_PATH, signal);
    if (process.env.FAKE_IGNORE_SIGNAL !== "1") process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  writeFileSync(process.env.FAKE_STARTED_PATH, String(process.pid));
  await Bun.sleep(5_000);
}
const delay = Number(
  stage === "preflight"
    ? process.env.FAKE_PREFLIGHT_DELAY_MS ?? 0
    : process.env.FAKE_MODEL_DELAY_MS ?? 0
);
if (delay > 0) await Bun.sleep(delay);
if (process.env.FAKE_TIMEOUT === "1" && !args.includes("status") && !args.includes("models")) {
  await Bun.sleep(5_000);
}
if (name === "claude" && args[0] === "auth") {
  if (process.env.FAKE_REMOVE_EXECUTABLE_AFTER_PREFLIGHT === "1") {
    unlinkSync(process.argv[1]);
  }
  switch (process.env.FAKE_CLAUDE_PREFLIGHT) {
    case "logged-out":
      console.log(JSON.stringify({loggedIn:false}));
      process.exit(0);
    case "malformed":
      console.log("{");
      process.exit(0);
    case "missing-logged-in":
      console.log(JSON.stringify({}));
      process.exit(0);
    case "nonboolean-logged-in":
      console.log(JSON.stringify({loggedIn:"false"}));
      process.exit(0);
    case "logged-out-nonzero":
      console.log(JSON.stringify({loggedIn:false}));
      process.exit(1);
    case "unrelated-nonzero":
      console.error("unexpected command failure");
      process.exit(1);
  }
  console.log(JSON.stringify({loggedIn:true}));
  process.exit(0);
}
if (name === "codex" && args[0] === "login") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (name === "grok" && args[0] === "models") {
  if (process.env.FAKE_GROK_PREFLIGHT_LOG_PATH) {
    appendFileSync(process.env.FAKE_GROK_PREFLIGHT_LOG_PATH, "attempt\\n");
  }
  const transientMarker = process.env.FAKE_GROK_TRANSIENT_UNAUTH_PATH;
  if (transientMarker && !existsSync(transientMarker)) {
    writeFileSync(transientMarker, String(process.pid));
    console.log("Available models:\\n  * grok-4.6 (default)");
    console.error("You are not authenticated.");
    process.exit(0);
  }
  if (process.env.FAKE_GROK_MISSING_MODEL === "1") {
    console.log("You are logged in with grok.com.\\nAvailable models:\\n  * grok-4.5 (default)");
    process.exit(0);
  }
  if (process.env.FAKE_GROK_UNAUTH === "1") {
    console.error("Not logged in. Run grok auth login.");
    process.exit(1);
  }
  console.log("You are logged in with grok.com.\\nAvailable models:\\n  * grok-4.6 (default)");
  process.exit(0);
}
const modelIndex = args.findIndex((value) => value === "--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "unknown";
const malformedUsage = {
  input_tokens: -1,
  cached_input_tokens: 1.5,
  cache_creation_input_tokens: Number.MAX_SAFE_INTEGER + 1,
  output_tokens: -2,
  reasoning_output_tokens: 3.5,
  total_tokens: Number.POSITIVE_INFINITY,
};
if (stage === "model" && process.env.FAKE_INVOCATION_LOG_PATH) {
  const promptBytes = name === "grok"
    ? new Uint8Array()
    : new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
  const prompt = new TextDecoder().decode(promptBytes);
  const promptBase64 = Buffer.from(promptBytes).toString("base64");
  writeFileSync(process.env.FAKE_INVOCATION_LOG_PATH, JSON.stringify({args, cwd: process.cwd(), prompt, promptBase64}));
}
if (process.env.FAKE_INVALID_MODEL === "1") {
  console.error("The requested model is not supported with this account.");
  process.exit(1);
}
if (stage === "model" && process.env.FAKE_DESCENDANT_HOLDS_PIPES_MS) {
  const seconds = Number(process.env.FAKE_DESCENDANT_HOLDS_PIPES_MS) / 1000;
  const descendant = Bun.spawn(["/bin/sh", "-c", "sleep " + seconds], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (process.env.FAKE_DESCENDANT_PID_PATH) {
    writeFileSync(process.env.FAKE_DESCENDANT_PID_PATH, String(descendant.pid));
  }
  descendant.unref();
}
if (stage === "model" && process.env.FAKE_SELF_SIGNAL) {
  process.kill(process.pid, process.env.FAKE_SELF_SIGNAL);
  await Bun.sleep(5_000);
}
if (name === "claude") {
  if (process.env.FAKE_CLAUDE_PAUSE_EXIT !== undefined) {
    console.log(JSON.stringify({
      duration_api_ms: 65277,
      session_id: "098e45a4-671d-4f4e-aaaa-51abd7fbc8a3",
      total_cost_usd: 1.0764304999999998,
      usage: {input_tokens:10,cache_creation_input_tokens:80240,cache_read_input_tokens:298407,output_tokens:4932},
      modelUsage: {[model]: {inputTokens: 10}},
      terminal_reason: process.env.FAKE_CLAUDE_PAUSE_REASON ?? "api_error",
      is_error: process.env.FAKE_CLAUDE_PAUSE_ERROR === "false" ? false : true,
      api_error_status: process.env.FAKE_CLAUDE_PAUSE_STATUS === "string" ? "429" : Number(process.env.FAKE_CLAUDE_PAUSE_STATUS ?? "429"),
      result: process.env.FAKE_CLAUDE_PAUSE_RESULT ?? "You've hit your session limit · resets 2:10pm (America/Toronto)",
      type: "result",
    }));
    if (process.env.FAKE_CLAUDE_PAUSE_WRITTEN_PATH) {
      writeFileSync(process.env.FAKE_CLAUDE_PAUSE_WRITTEN_PATH, String(process.pid));
    }
    if (process.env.FAKE_CLAUDE_PAUSE_WAIT_FOR_SIGNAL === "1") {
      await Bun.sleep(5_000);
    }
    process.exit(Number(process.env.FAKE_CLAUDE_PAUSE_EXIT));
  }
  console.log(JSON.stringify({result:"CLAUDE_OK",session_id:"c1",usage:process.env.FAKE_MALFORMED_TELEMETRY === "1" ? malformedUsage : {input_tokens:10,output_tokens:2},total_cost_usd:process.env.FAKE_MALFORMED_TELEMETRY === "1" ? -0.01 : 0.01,modelUsage:{[model]:{}}}));
} else if (name === "codex") {
  console.log(JSON.stringify({type:"thread.started",thread_id:"o1"}));
  if (process.env.FAKE_CODEX_FAILURE_LENGTH) {
    console.log(JSON.stringify({type:"turn.failed",error:{message:"x".repeat(Number(process.env.FAKE_CODEX_FAILURE_LENGTH))}}));
    process.exit(0);
  }
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"CODEX_OK"}}));
  console.log(JSON.stringify({type:"turn.completed",usage:process.env.FAKE_MALFORMED_TELEMETRY === "1" ? malformedUsage : {input_tokens:20,cached_input_tokens:5,output_tokens:3,reasoning_output_tokens:1}}));
} else {
  console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"progress"}]}}));
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"GROK_OK",session_id:"g1",usage:{input_tokens:30,output_tokens:4,total_tokens:34},total_cost_usd:0.02,modelUsage:{[model + "-build"]:{}}}));
}
if (process.env.FAKE_MODEL_EXITING_PATH) {
  writeFileSync(process.env.FAKE_MODEL_EXITING_PATH, String(process.pid));
}
`;

function makeExecutable(name: string): void {
  const path = join(bin, name);
  writeFileSync(path, fake);
  chmodSync(path, 0o755);
}

function options(provider: Provider, suffix: string = provider): RunnerOptions {
  const parent = provider === "codex" ? "claude" : "codex";
  const model =
    provider === "claude"
      ? "claude-fable-5-1"
      : provider === "codex"
        ? "gpt-5.6-sol"
        : "grok-4.6";
  return {
    parent,
    provider,
    model,
    effort: provider === "grok" ? "xhigh" : "max",
    mode: "read-only",
    promptPath: join(scratch, "prompt.md"),
    cwd: scratch,
    outputPath: join(scratch, `${suffix}.out`),
    receiptPath: join(scratch, `${suffix}.receipt.json`),
    timeoutMs: null,
    managedAttempt: null,
  };
}

function receipt(path: string): RunnerReceiptV2 {
  const parsed = parseRunnerReceipt(JSON.parse(readFileSync(path, "utf8")));
  if (parsed === null) throw new Error(`runner wrote an invalid receipt: ${path}`);
  return parsed;
}

function managedOptions(
  suffix: string = "managed-pause",
  timeoutMs: number | null = null
): RunnerOptions {
  const input = { ...options("claude", suffix), timeoutMs };
  const promptSha256 = sha256Hex(readFileSync(input.promptPath));
  return {
    ...input,
    managedAttempt: {
      laneId: "manifest-review-claude",
      attemptId: "manifest-review-claude-000001",
      laneFingerprint: laneFingerprint(input, promptSha256),
      promptSha256,
    },
  };
}

function withManagedAttempt(input: RunnerOptions): RunnerOptions {
  const promptSha256 = sha256Hex(readFileSync(input.promptPath));
  return {
    ...input,
    managedAttempt: {
      laneId: `managed-${input.provider}`,
      attemptId: `managed-${input.provider}-000001`,
      laneFingerprint: laneFingerprint(input, promptSha256),
      promptSha256,
    },
  };
}

function expectManagedInvocation(input: RunnerOptions, invocationLog: string): void {
  if (input.managedAttempt === null) {
    throw new Error("managed test setup lost its claim");
  }
  const executable = join(bin, input.provider);
  const invocation = invocationCommand(input);
  const preflight = preflightCommand(input.provider);
  expect(JSON.parse(readFileSync(invocationLog, "utf8"))).toEqual({
    args: [...invocation.args],
    cwd: realpathSync(input.cwd),
    prompt: readFileSync(input.promptPath, "utf8"),
    promptBase64: readFileSync(input.promptPath).toString("base64"),
  });
  const recorded = receipt(input.receiptPath);
  if (recorded.schemaVersion !== 2) {
    throw new Error("managed invocation wrote a legacy receipt");
  }
  expect(recorded.argv).toEqual([executable, ...invocation.args]);
  expect(recorded.preflight.argv).toEqual([executable, ...preflight.args]);
  expect(recorded.managedAttempt).toEqual({
    ...input.managedAttempt,
    verified: true,
  });
}

function runnerArgs(input: RunnerOptions): string[] {
  const args = [
    join(import.meta.dir, "pstack-runner"),
    "--parent", input.parent,
    "--provider", input.provider,
    "--model", input.model,
    "--effort", input.effort,
    "--mode", input.mode,
    "--prompt", input.promptPath,
    "--cwd", input.cwd,
    "--output", input.outputPath,
    "--receipt", input.receiptPath,
  ];
  if (input.timeoutMs !== null) {
    args.push("--timeout", String(input.timeoutMs / 1_000));
  }
  if (input.managedAttempt !== null) {
    args.push(
      "--lane-id", input.managedAttempt.laneId,
      "--attempt-id", input.managedAttempt.attemptId,
      "--lane-fingerprint", input.managedAttempt.laneFingerprint,
      "--prompt-sha256", input.managedAttempt.promptSha256
    );
  }
  return args;
}

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function exitWithin(child: Bun.Subprocess, milliseconds: number): Promise<number> {
  const result = await Promise.race([
    child.exited,
    Bun.sleep(milliseconds).then(() => null),
  ]);
  if (result !== null) return result;
  child.kill("SIGKILL");
  await child.exited;
  throw new Error(`runner did not exit within ${milliseconds}ms`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!processIsAlive(pid)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-runner-test-"));
  bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(scratch, "prompt.md"), "Return the marker.");
  for (const name of ["claude", "codex", "grok"]) makeExecutable(name);
  previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${dirname(process.execPath)}:${previousPath ?? ""}`;
  delete process.env.FAKE_TIMEOUT;
  delete process.env.FAKE_INVALID_MODEL;
  delete process.env.FAKE_CANCEL;
  delete process.env.FAKE_CANCEL_STAGE;
  delete process.env.FAKE_IGNORE_SIGNAL;
  delete process.env.FAKE_PREFLIGHT_DELAY_MS;
  delete process.env.FAKE_MODEL_DELAY_MS;
  delete process.env.FAKE_STARTED_PATH;
  delete process.env.FAKE_TERMINATED_PATH;
  delete process.env.FAKE_PREFLIGHT_STARTED_PATH;
  delete process.env.FAKE_MODEL_STARTED_PATH;
  delete process.env.FAKE_MODEL_EXITING_PATH;
  delete process.env.FAKE_REMOVE_EXECUTABLE_AFTER_PREFLIGHT;
  delete process.env.FAKE_CLAUDE_PREFLIGHT;
  delete process.env.FAKE_GROK_UNAUTH;
  delete process.env.FAKE_GROK_TRANSIENT_UNAUTH_PATH;
  delete process.env.FAKE_GROK_PREFLIGHT_LOG_PATH;
  delete process.env.FAKE_GROK_MISSING_MODEL;
  delete process.env.FAKE_DESCENDANT_HOLDS_PIPES_MS;
  delete process.env.FAKE_DESCENDANT_PID_PATH;
  delete process.env.FAKE_SELF_SIGNAL;
  delete process.env.FAKE_CLAUDE_PAUSE_EXIT;
  delete process.env.FAKE_CLAUDE_PAUSE_REASON;
  delete process.env.FAKE_CLAUDE_PAUSE_ERROR;
  delete process.env.FAKE_CLAUDE_PAUSE_STATUS;
  delete process.env.FAKE_CLAUDE_PAUSE_RESULT;
  delete process.env.FAKE_INVOCATION_LOG_PATH;
  delete process.env.FAKE_CLAUDE_PAUSE_WAIT_FOR_SIGNAL;
  delete process.env.FAKE_CLAUDE_PAUSE_WRITTEN_PATH;
  delete process.env.FAKE_CODEX_FAILURE_LENGTH;
  delete process.env.FAKE_MALFORMED_TELEMETRY;
});

afterEach(() => {
  process.env.PATH = previousPath;
  delete process.env.FAKE_TIMEOUT;
  delete process.env.FAKE_INVALID_MODEL;
  delete process.env.FAKE_CANCEL;
  delete process.env.FAKE_CANCEL_STAGE;
  delete process.env.FAKE_IGNORE_SIGNAL;
  delete process.env.FAKE_PREFLIGHT_DELAY_MS;
  delete process.env.FAKE_MODEL_DELAY_MS;
  delete process.env.FAKE_STARTED_PATH;
  delete process.env.FAKE_TERMINATED_PATH;
  delete process.env.FAKE_PREFLIGHT_STARTED_PATH;
  delete process.env.FAKE_MODEL_STARTED_PATH;
  delete process.env.FAKE_MODEL_EXITING_PATH;
  delete process.env.FAKE_REMOVE_EXECUTABLE_AFTER_PREFLIGHT;
  delete process.env.FAKE_CLAUDE_PREFLIGHT;
  delete process.env.FAKE_GROK_UNAUTH;
  delete process.env.FAKE_GROK_TRANSIENT_UNAUTH_PATH;
  delete process.env.FAKE_GROK_PREFLIGHT_LOG_PATH;
  delete process.env.FAKE_GROK_MISSING_MODEL;
  delete process.env.FAKE_DESCENDANT_HOLDS_PIPES_MS;
  delete process.env.FAKE_DESCENDANT_PID_PATH;
  delete process.env.FAKE_SELF_SIGNAL;
  delete process.env.FAKE_CLAUDE_PAUSE_EXIT;
  delete process.env.FAKE_CLAUDE_PAUSE_REASON;
  delete process.env.FAKE_CLAUDE_PAUSE_ERROR;
  delete process.env.FAKE_CLAUDE_PAUSE_STATUS;
  delete process.env.FAKE_CLAUDE_PAUSE_RESULT;
  delete process.env.FAKE_INVOCATION_LOG_PATH;
  delete process.env.FAKE_CLAUDE_PAUSE_WAIT_FOR_SIGNAL;
  delete process.env.FAKE_CLAUDE_PAUSE_WRITTEN_PATH;
  delete process.env.FAKE_CODEX_FAILURE_LENGTH;
  delete process.env.FAKE_MALFORMED_TELEMETRY;
  rmSync(scratch, { recursive: true, force: true });
});

describe("runLane", () => {
  it("classifies the structured Claude session limit for an unmanaged lane", async () => {
    process.env.FAKE_CLAUDE_PAUSE_EXIT = "1";
    const input = options("claude", "unmanaged-pause");

    const result = await runLane(input);

    expect(result.exitCode).toBe(75);
    expect(receipt(input.receiptPath)).toMatchObject({
      schemaVersion: 2,
      status: "provider-paused",
      managedAttempt: null,
      providerPause: { kind: "claude-session-limit" },
    });
  });

  for (const exit of [1, 0]) {
    it(`records Claude's structured session limit when the child exits ${exit}`, async () => {
      process.env.FAKE_CLAUDE_PAUSE_EXIT = String(exit);
      const input = managedOptions(`managed-pause-${exit}`);
      const invocationLog = join(scratch, `managed-pause-${exit}.invocation.json`);
      process.env.FAKE_INVOCATION_LOG_PATH = invocationLog;

      const result = await runLane(input);

      expect(result.exitCode).toBe(75);
      expectManagedInvocation(input, invocationLog);
      expect(existsSync(input.outputPath)).toBe(false);
      expect(receipt(input.receiptPath)).toMatchObject({
        schemaVersion: 2,
        status: "provider-paused",
        managedAttempt: {
          ...input.managedAttempt,
          verified: true,
        },
        providerPause: {
          kind: "claude-session-limit",
          terminalReason: "api_error",
          apiStatus: 429,
          message: "You've hit your session limit · resets 2:10pm (America/Toronto)",
          resetEvidence: "You've hit your session limit · resets 2:10pm (America/Toronto)",
        },
        sessionId: "098e45a4-671d-4f4e-aaaa-51abd7fbc8a3",
        usage: { inputTokens: 10, outputTokens: 4932 },
        costUsd: 1.0764304999999998,
        error: null,
      });
    });
  }

  it("does not treat malformed Claude 429 lookalikes as provider pauses", async () => {
    const cases: Array<readonly [string, Record<string, string>]> = [
      ["string status", { FAKE_CLAUDE_PAUSE_STATUS: "string" }],
      ["wrong terminal reason", { FAKE_CLAUDE_PAUSE_REASON: "rate_limit" }],
      ["unrelated result", { FAKE_CLAUDE_PAUSE_RESULT: "HTTP 429" }],
      ["wrong result prefix", { FAKE_CLAUDE_PAUSE_RESULT: "You've hit your usage limit" }],
    ];
    for (const [label, overrides] of cases) {
      process.env.FAKE_CLAUDE_PAUSE_EXIT = "1";
      Object.assign(process.env, overrides);
      const input = options("claude", `not-paused-${label}`);
      const result = await runLane(input);
      expect(result.exitCode).not.toBe(75);
      expect(receipt(input.receiptPath).status).not.toBe("provider-paused");
      delete process.env.FAKE_CLAUDE_PAUSE_STATUS;
      delete process.env.FAKE_CLAUDE_PAUSE_REASON;
      delete process.env.FAKE_CLAUDE_PAUSE_RESULT;
    }
  });

  it("fails managed identity validation before Claude preflight", async () => {
    const input = managedOptions("managed-bad-digest");
    if (input.managedAttempt === null) throw new Error("managed test setup lost its claim");
    const preflightStarted = join(scratch, "managed-bad-digest.preflight");
    const modelStarted = join(scratch, "managed-bad-digest.model");
    const invocationLog = join(scratch, "managed-bad-digest.invocation.json");
    process.env.FAKE_PREFLIGHT_STARTED_PATH = preflightStarted;
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    process.env.FAKE_INVOCATION_LOG_PATH = invocationLog;
    const invalid: RunnerOptions = {
      ...input,
      managedAttempt: {
        ...input.managedAttempt,
        promptSha256: "0".repeat(64),
      },
    };

    const result = await runLane(invalid);

    expect(result.exitCode).toBe(70);
    expect(existsSync(preflightStarted)).toBe(false);
    expect(existsSync(modelStarted)).toBe(false);
    expect(existsSync(invocationLog)).toBe(false);
    expect(existsSync(invalid.outputPath)).toBe(false);
    expect(receipt(invalid.receiptPath)).toMatchObject({
      schemaVersion: 2,
      status: "child-failed",
      managedAttempt: {
        ...invalid.managedAttempt,
        verified: false,
        reason: "prompt-digest-mismatch",
      },
      providerPause: null,
    });
  });

  it("rejects every stale managed lane input with the correct prompt digest before preflight", async () => {
    const mutations: Array<readonly [
      string,
      (input: RunnerOptions) => RunnerOptions,
    ]> = [
      ["model", (input) => ({ ...input, model: "claude-opus-5" })],
      ["effort", (input) => ({ ...input, effort: "xhigh" })],
      ["mode", (input) => ({ ...input, mode: "isolated-write" })],
      ["cwd", (input) => {
        const cwd = join(scratch, "stale-cwd-alternate");
        mkdirSync(cwd, { recursive: true });
        return { ...input, cwd };
      }],
      ["timeout", (input) => ({ ...input, timeoutMs: 1_000 })],
    ];

    for (const [field, mutate] of mutations) {
      const input = mutate(managedOptions(`managed-stale-${field}`));
      if (input.managedAttempt === null) {
        throw new Error("managed test setup lost its claim");
      }
      const preflightStarted = join(scratch, `managed-stale-${field}.preflight`);
      const modelStarted = join(scratch, `managed-stale-${field}.model`);
      const invocationLog = join(scratch, `managed-stale-${field}.invocation.json`);
      process.env.FAKE_PREFLIGHT_STARTED_PATH = preflightStarted;
      process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
      process.env.FAKE_INVOCATION_LOG_PATH = invocationLog;

      const result = await runLane(input);

      expect(input.managedAttempt.promptSha256).toBe(
        sha256Hex(readFileSync(input.promptPath, "utf8"))
      );
      expect(result.exitCode).toBe(70);
      expect(existsSync(preflightStarted)).toBe(false);
      expect(existsSync(modelStarted)).toBe(false);
      expect(existsSync(invocationLog)).toBe(false);
      expect(receipt(input.receiptPath)).toMatchObject({
        status: "child-failed",
        managedAttempt: {
          ...input.managedAttempt,
          verified: false,
          reason: "lane-fingerprint-mismatch",
        },
        providerPause: null,
      });
    }
  });

  it("receipts an unreadable managed prompt without running preflight", async () => {
    const input = managedOptions("managed-unreadable-prompt");
    if (input.managedAttempt === null) throw new Error("managed test setup lost its claim");
    const preflightStarted = join(scratch, "managed-unreadable-prompt.preflight");
    const modelStarted = join(scratch, "managed-unreadable-prompt.model");
    const invocationLog = join(scratch, "managed-unreadable-prompt.invocation.json");
    process.env.FAKE_PREFLIGHT_STARTED_PATH = preflightStarted;
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    process.env.FAKE_INVOCATION_LOG_PATH = invocationLog;
    chmodSync(input.promptPath, 0o000);
    try {
      const result = await runLane(input);

      expect(result.exitCode).toBe(70);
      expect(existsSync(preflightStarted)).toBe(false);
      expect(existsSync(modelStarted)).toBe(false);
      expect(existsSync(invocationLog)).toBe(false);
      expect(existsSync(input.outputPath)).toBe(false);
      expect(receipt(input.receiptPath)).toMatchObject({
        status: "child-failed",
        managedAttempt: {
          ...input.managedAttempt,
          verified: false,
          reason: "prompt-unreadable",
        },
        providerPause: null,
      });
    } finally {
      chmodSync(input.promptPath, 0o600);
    }
  });

  it("rejects managed Grok before reserving artifacts or starting a provider", async () => {
    const input = withManagedAttempt(options("grok", "managed-grok"));
    const preflightStarted = join(scratch, "managed-grok.preflight");
    const modelStarted = join(scratch, "managed-grok.model");
    const invocationLog = join(scratch, "managed-grok.invocation.json");
    process.env.FAKE_PREFLIGHT_STARTED_PATH = preflightStarted;
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    process.env.FAKE_INVOCATION_LOG_PATH = invocationLog;
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(runnerArgs(input).slice(1), Date.now(), {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });

    expect(exitCode).toBe(64);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain(
      "managed Grok attempts are unsupported because Grok cannot consume verified prompt bytes"
    );
    expect(existsSync(preflightStarted)).toBe(false);
    expect(existsSync(modelStarted)).toBe(false);
    expect(existsSync(invocationLog)).toBe(false);
    expect(existsSync(input.outputPath)).toBe(false);
    expect(existsSync(input.receiptPath)).toBe(false);
  });

  it("gives an explicit timeout precedence over a pending pause envelope", async () => {
    process.env.FAKE_CLAUDE_PAUSE_EXIT = "1";
    process.env.FAKE_CLAUDE_PAUSE_WAIT_FOR_SIGNAL = "1";
    const modelStarted = join(scratch, "managed-pause-timeout.model");
    const invocationLog = join(scratch, "managed-pause-timeout.invocation.json");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    process.env.FAKE_INVOCATION_LOG_PATH = invocationLog;
    const input = managedOptions("managed-pause-timeout", 1_000);

    const result = await runLane(input);

    expect(result.exitCode).toBe(124);
    expect(existsSync(modelStarted)).toBe(true);
    expectManagedInvocation(input, invocationLog);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "timed-out",
      preflight: { status: "passed" },
      providerPause: null,
      error: {
        evidence: expect.stringContaining("You've hit your session limit"),
      },
    });
  });

  it("gives cancellation precedence over a received pause envelope", async () => {
    const input = managedOptions("managed-pause-cancelled");
    const modelStarted = join(scratch, "managed-pause-cancelled.model");
    const pauseWritten = join(scratch, "managed-pause-cancelled.pause-written");
    const invocationLog = join(scratch, "managed-pause-cancelled.invocation.json");
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: {
        ...process.env,
        FAKE_CLAUDE_PAUSE_EXIT: "1",
        FAKE_CLAUDE_PAUSE_WAIT_FOR_SIGNAL: "1",
        FAKE_CLAUDE_PAUSE_WRITTEN_PATH: pauseWritten,
        FAKE_MODEL_STARTED_PATH: modelStarted,
        FAKE_INVOCATION_LOG_PATH: invocationLog,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();
    await waitFor(pauseWritten);
    runner.kill("SIGTERM");

    expect(await exitWithin(runner, 3_000)).toBe(130);
    await Promise.all([stdout, stderr]);
    expect(existsSync(modelStarted)).toBe(true);
    expectManagedInvocation(input, invocationLog);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "cancelled",
      providerPause: null,
      error: {
        evidence: expect.stringContaining("You've hit your session limit"),
      },
    });
  });

  it("normalizes the executable found through a trailing-slash PATH entry", async () => {
    process.env.PATH = `${bin}/:${dirname(process.execPath)}:${previousPath ?? ""}`;
    const input = options("claude", "normalized-executable");

    const result = await runLane(input);

    expect(result.exitCode).toBe(0);
    const normalized = resolve(bin, "claude");
    expect(receipt(input.receiptPath)).toMatchObject({
      executable: normalized,
      preflight: { argv: [normalized, ...preflightCommand("claude").args] },
      argv: [normalized, ...invocationCommand(input).args],
    });
  });

  it("binds a successful managed receipt to the exact provider invocation", async () => {
    const input = managedOptions("managed-complete");
    const invocationLog = join(scratch, "managed-complete.invocation.json");
    process.env.FAKE_INVOCATION_LOG_PATH = invocationLog;

    const result = await runLane(input);

    expect(result.exitCode).toBe(0);
    expectManagedInvocation(input, invocationLog);
    const recorded = receipt(input.receiptPath);
    expect(recorded).toMatchObject({
      schemaVersion: 2,
      status: "complete",
      managedAttempt: { ...input.managedAttempt, verified: true },
      providerPause: null,
      error: null,
    });
    if (recorded.status !== "complete") throw new Error("missing completion receipt");
    expect(recorded.outputSha256).toBe(sha256Hex(readFileSync(input.outputPath)));
  });

  it("round-trips managed receipts after omitting malformed provider telemetry", async () => {
    process.env.FAKE_MALFORMED_TELEMETRY = "1";
    for (const provider of ["claude", "codex"] as const) {
      const input = withManagedAttempt(options(provider, `managed-malformed-${provider}`));

      const result = await runLane(input);
      const recorded = receipt(input.receiptPath);

      expect(result.exitCode).toBe(0);
      expect(recorded).toMatchObject({
        status: "complete",
        managedAttempt: { ...input.managedAttempt, verified: true },
        usage: null,
        costUsd: null,
      });
    }
  });

  it("hashes and sends the exact managed prompt bytes", async () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x61, 0x0a]);
    writeFileSync(join(scratch, "prompt.md"), bytes);
    const input = managedOptions("managed-bytes");
    const invocationLog = join(scratch, "managed-bytes.invocation.json");
    process.env.FAKE_INVOCATION_LOG_PATH = invocationLog;

    const result = await runLane(input);

    expect(result.exitCode).toBe(0);
    expectManagedInvocation(input, invocationLog);
    expect(input.managedAttempt?.promptSha256).toBe(sha256Hex(bytes));
  });

  for (const [parent, provider] of [
    ["claude", "codex"],
    ["claude", "grok"],
    ["codex", "claude"],
    ["codex", "grok"],
  ] as const) {
    it(`executes and receipts the ${parent}-to-${provider} external lane`, async () => {
      const input = { ...options(provider), parent };
      const result = await runLane(input);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(input.outputPath, "utf8")).toContain(
        provider.toUpperCase()
      );
      expect(receipt(input.receiptPath)).toMatchObject({
        status: "complete",
        provider,
        model: input.model,
        modelVerified: provider !== "codex",
        modelEvidence: provider === "codex" ? "pinned-argv" : "provider-report",
        preflight: { status: "passed" },
      });
    });
  }

  it("records Codex's exact argv without fabricating a reported model", async () => {
    const input = options("codex");
    const result = await runLane(input);
    expect(result.exitCode).toBe(0);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "complete",
      model: "gpt-5.6-sol",
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
    });
  });

  it("bounds a provider parse failure so the serialized receipt remains valid", async () => {
    process.env.FAKE_CODEX_FAILURE_LENGTH = "5000";
    const input = options("codex", "long-provider-error");

    const result = await runLane(input);
    const recorded = receipt(input.receiptPath);

    expect(result.exitCode).toBe(65);
    expect(recorded.status).toBe("malformed-output");
    expect(recorded.error?.message).toHaveLength(4_000);
    expect(recorded.error?.evidence.length).toBeLessThanOrEqual(4_000);
  });

  it("classifies an unavailable model without falling back", async () => {
    process.env.FAKE_INVALID_MODEL = "1";
    const input = options("codex");
    const result = await runLane(input);
    expect(result.exitCode).toBe(69);
    expect(existsSync(input.outputPath)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "unavailable-model",
      model: "gpt-5.6-sol",
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
    });
  });

  it("classifies a successful Claude logged-out preflight as unauthenticated", async () => {
    process.env.FAKE_CLAUDE_PREFLIGHT = "logged-out";
    const modelStarted = join(scratch, "claude-logged-out-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = options("claude", "claude-logged-out");

    const result = await runLane(input);

    expect(result.exitCode).toBe(77);
    expect(existsSync(modelStarted)).toBe(false);
    expect(existsSync(input.outputPath)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "unauthenticated",
      exitCode: 0,
      preflight: { status: "failed" },
    });
  });

  for (const [mode, label] of [
    ["malformed", "malformed JSON"],
    ["missing-logged-in", "a missing loggedIn field"],
    ["nonboolean-logged-in", "a nonboolean loggedIn field"],
  ]) {
    it(`classifies a successful Claude preflight with ${label} as child-failed`, async () => {
      process.env.FAKE_CLAUDE_PREFLIGHT = mode;
      const modelStarted = join(scratch, `${mode}-model.started`);
      process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
      const input = options("claude", mode);

      const result = await runLane(input);

      expect(result.exitCode).toBe(70);
      expect(existsSync(modelStarted)).toBe(false);
      expect(existsSync(input.outputPath)).toBe(false);
      expect(receipt(input.receiptPath)).toMatchObject({
        status: "child-failed",
        exitCode: 0,
        preflight: { status: "failed" },
      });
    });
  }

  it("classifies a nonzero Claude logged-out preflight as unauthenticated", async () => {
    process.env.FAKE_CLAUDE_PREFLIGHT = "logged-out-nonzero";
    const modelStarted = join(scratch, "claude-nonzero-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = options("claude", "claude-logged-out-nonzero");

    const result = await runLane(input);

    expect(result.exitCode).toBe(77);
    expect(existsSync(modelStarted)).toBe(false);
    expect(existsSync(input.outputPath)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "unauthenticated",
      exitCode: 1,
      preflight: { status: "failed" },
    });
  });

  it("classifies unrelated nonzero Claude preflight output as child-failed", async () => {
    process.env.FAKE_CLAUDE_PREFLIGHT = "unrelated-nonzero";
    const modelStarted = join(scratch, "claude-unrelated-nonzero-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = options("claude", "claude-unrelated-nonzero");

    const result = await runLane(input);

    expect(result.exitCode).toBe(70);
    expect(existsSync(modelStarted)).toBe(false);
    expect(existsSync(input.outputPath)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "child-failed",
      exitCode: 1,
      preflight: { status: "failed" },
    });
  });

  it("runs the same Claude lane with fresh artifact paths and preserves the first receipt", async () => {
    process.env.FAKE_CLAUDE_PREFLIGHT = "logged-out";
    const first = options("claude", "claude-sandboxed");
    expect((await runLane(first)).exitCode).toBe(77);
    const firstReceipt = readFileSync(first.receiptPath, "utf8");

    delete process.env.FAKE_CLAUDE_PREFLIGHT;
    const second: RunnerOptions = {
      ...first,
      outputPath: join(scratch, "claude-elevated.out"),
      receiptPath: join(scratch, "claude-elevated.receipt.json"),
    };
    expect((await runLane(second)).exitCode).toBe(0);

    expect(second.outputPath).not.toBe(first.outputPath);
    expect(second.receiptPath).not.toBe(first.receiptPath);
    expect(existsSync(first.outputPath)).toBe(false);
    expect(readFileSync(first.receiptPath, "utf8")).toBe(firstReceipt);
    expect(receipt(second.receiptPath).status).toBe("complete");
    expect(readFileSync(second.outputPath, "utf8")).toContain("CLAUDE_OK");
  });

  it("retries a contradictory Grok authentication preflight before running the model", async () => {
    const transientMarker = join(scratch, "grok-transient-unauth.seen");
    const preflightLog = join(scratch, "grok-transient-unauth.log");
    process.env.FAKE_GROK_TRANSIENT_UNAUTH_PATH = transientMarker;
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    const modelStarted = join(scratch, "grok-transient-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = options("grok", "grok-transient-unauth");
    const result = await runLane(input);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(preflightLog, "utf8")).toBe("attempt\nattempt\n");
    expect(existsSync(modelStarted)).toBe(true);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "complete",
      preflight: { status: "passed" },
    });
    expect(receipt(input.receiptPath).preflight.evidence).toContain(
      "You are not authenticated."
    );
    expect(receipt(input.receiptPath).preflight.evidence).toContain(
      "attempt 2 passed"
    );
  }, 10_000);

  it("classifies Grok authentication failure after two consecutive preflights", async () => {
    process.env.FAKE_GROK_UNAUTH = "1";
    const preflightLog = join(scratch, "grok-unauthenticated.log");
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    const modelStarted = join(scratch, "grok-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = options("grok", "grok-unauthenticated");
    const result = await runLane(input);

    expect(result.exitCode).toBe(77);
    expect(readFileSync(preflightLog, "utf8")).toBe("attempt\nattempt\n");
    expect(existsSync(modelStarted)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "unauthenticated",
      preflight: { status: "failed" },
    });
    expect(receipt(input.receiptPath).preflight.evidence).toContain(
      "attempt 2 failed"
    );
  }, 10_000);

  it("counts the Grok retry delay against the wrapper deadline", async () => {
    const transientMarker = join(scratch, "grok-deadline-unauth.seen");
    const preflightLog = join(scratch, "grok-deadline-unauth.log");
    process.env.FAKE_GROK_TRANSIENT_UNAUTH_PATH = transientMarker;
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    const modelStarted = join(scratch, "grok-deadline-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = {
      ...options("grok", "grok-preflight-retry-deadline"),
      timeoutMs: 700,
    };
    const result = await runLane(input);
    const recorded = receipt(input.receiptPath);

    expect(result.exitCode).toBe(124);
    expect(readFileSync(preflightLog, "utf8")).toBe("attempt\n");
    expect(existsSync(modelStarted)).toBe(false);
    expect(recorded).toMatchObject({
      status: "timed-out",
      preflight: { status: "timed-out" },
    });
    expect(recorded.preflight.evidence).toContain("You are not authenticated.");
    expect(recorded.elapsedMs).toBeLessThan(1_200);
  });

  it("cancels during the Grok retry delay without starting another preflight", async () => {
    const transientMarker = join(scratch, "grok-cancel-unauth.pid");
    const preflightLog = join(scratch, "grok-cancel-unauth.log");
    const input = options("grok", "grok-preflight-retry-cancelled");
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: {
        ...process.env,
        FAKE_GROK_TRANSIENT_UNAUTH_PATH: transientMarker,
        FAKE_GROK_PREFLIGHT_LOG_PATH: preflightLog,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();
    await waitFor(transientMarker);
    await waitForExit(Number(readFileSync(transientMarker, "utf8")));
    await Bun.sleep(200);
    runner.kill("SIGTERM");

    expect(await exitWithin(runner, 2_000)).toBe(130);
    await Promise.all([stdout, stderr]);
    expect(readFileSync(preflightLog, "utf8")).toBe("attempt\n");
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "cancelled",
      preflight: { status: "cancelled" },
      error: {
        message: "launcher received SIGTERM during authentication preflight retry delay",
      },
    });
  });

  it("does not retry a Grok preflight with a missing model", async () => {
    process.env.FAKE_GROK_MISSING_MODEL = "1";
    const preflightLog = join(scratch, "grok-missing-model.log");
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    const modelStarted = join(scratch, "grok-missing-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = options("grok", "grok-missing-model");
    const result = await runLane(input);

    expect(result.exitCode).toBe(69);
    expect(readFileSync(preflightLog, "utf8")).toBe("attempt\n");
    expect(existsSync(modelStarted)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "unavailable-model",
      preflight: { status: "failed" },
    });
  });

  it("kills a timed-out child and preserves a failure receipt", async () => {
    process.env.FAKE_TIMEOUT = "1";
    const input = { ...options("claude"), timeoutMs: 30 };
    const result = await runLane(input);
    expect(result.exitCode).toBe(124);
    expect(existsSync(input.outputPath)).toBe(false);
    expect(receipt(input.receiptPath).status).toBe("timed-out");
  });

  it("does not spawn the model when preflight exhausts the wrapper deadline", async () => {
    const modelStarted = join(scratch, "deadline-model.started");
    const input = { ...options("claude", "preflight-deadline"), timeoutMs: 300 };
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: {
        ...process.env,
        FAKE_PREFLIGHT_DELAY_MS: "1000",
        FAKE_MODEL_STARTED_PATH: modelStarted,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();

    expect(await exitWithin(runner, 2_000)).toBe(124);
    await Promise.all([stdout, stderr]);
    expect(existsSync(modelStarted)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "timed-out",
      signal: "SIGTERM",
      preflight: { status: "timed-out" },
    });
  });

  it("lets a delayed wrapper lane finish when timeout is omitted", async () => {
    const input = options("claude", "unbounded-default");
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: { ...process.env, FAKE_MODEL_DELAY_MS: "400" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();

    expect(await exitWithin(runner, 3_000)).toBe(0);
    await Promise.all([stdout, stderr]);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "complete",
      signal: null,
    });
    expect(receipt(input.receiptPath).elapsedMs).toBeGreaterThanOrEqual(400);
  });

  it("keeps a very long explicit deadline without timer overflow", async () => {
    const input = {
      ...options("claude", "long-runtime-deadline"),
      timeoutMs: 2_147_483_648,
    };
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: { ...process.env, FAKE_MODEL_DELAY_MS: "100" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();

    expect(await exitWithin(runner, 2_000)).toBe(0);
    await Promise.all([stdout, stderr]);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "complete",
      signal: null,
      exitCode: 0,
    });
  });

  it("counts wrapper import and parsing time against an explicit deadline", async () => {
    const preflightStarted = join(scratch, "expired-preflight.started");
    const modelStarted = join(scratch, "expired-model.started");
    process.env.FAKE_PREFLIGHT_STARTED_PATH = preflightStarted;
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = { ...options("claude", "expired-at-entry"), timeoutMs: 100 };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      runnerArgs(input).slice(1),
      Date.now() - 1_000,
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      }
    );

    expect(exitCode).toBe(124);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain('"status":"timed-out"');
    expect(existsSync(preflightStarted)).toBe(false);
    expect(existsSync(modelStarted)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "timed-out",
      preflight: { status: "timed-out" },
    });
  });

  it("uses monotonic elapsed time for a deadline after wall-clock rollback", async () => {
    process.env.FAKE_MODEL_DELAY_MS = "1000";
    const input = {
      ...options("claude", "wall-clock-rollback"),
      timeoutMs: 300,
    };
    const startedAt = Date.now() + 60_000;

    const result = await runLane(input, startedAt);
    const recorded = receipt(input.receiptPath);

    expect(result.exitCode).toBe(124);
    expect(recorded).toMatchObject({
      status: "timed-out",
      startedAt: new Date(startedAt).toISOString(),
      preflight: { status: "passed" },
    });
    expect(recorded.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(Date.parse(recorded.completedAt) - Date.parse(recorded.startedAt)).toBe(
      recorded.elapsedMs
    );
  });

  it("spends one explicit deadline across preflight and model execution", async () => {
    process.env.FAKE_PREFLIGHT_DELAY_MS = "1200";
    process.env.FAKE_MODEL_DELAY_MS = "1200";
    const input = { ...options("claude"), timeoutMs: 1_500 };
    const result = await runLane(input);
    const recorded = receipt(input.receiptPath);

    expect(result.exitCode).toBe(124);
    expect(recorded.status).toBe("timed-out");
    expect(recorded.preflight.status).toBe("passed");
    expect(recorded.elapsedMs).toBeLessThan(2_100);
  });

  it("bounds a descendant-held pipe by the explicit deadline without fabricating a signal", async () => {
    const descendantPidPath = join(scratch, "deadline-descendant.pid");
    const input = { ...options("claude", "deadline-drain"), timeoutMs: 700 };
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: {
        ...process.env,
        FAKE_DESCENDANT_HOLDS_PIPES_MS: "5000",
        FAKE_DESCENDANT_PID_PATH: descendantPidPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();

    expect(await exitWithin(runner, 2_000)).toBe(124);
    await Promise.all([stdout, stderr]);
    const recorded = receipt(input.receiptPath);
    expect(recorded).toMatchObject({
      status: "timed-out",
      exitCode: 0,
      signal: null,
      preflight: { status: "passed" },
    });
    expect(recorded.elapsedMs).toBeLessThan(1_500);

    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });

  it("does not claim a signal was sent to an already signal-reaped child", async () => {
    const descendantPidPath = join(scratch, "signalled-descendant.pid");
    const input = { ...options("claude", "signalled-drain"), timeoutMs: 700 };
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: {
        ...process.env,
        FAKE_DESCENDANT_HOLDS_PIPES_MS: "5000",
        FAKE_DESCENDANT_PID_PATH: descendantPidPath,
        FAKE_SELF_SIGNAL: "SIGTERM",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();

    expect(await exitWithin(runner, 2_000)).toBe(124);
    await Promise.all([stdout, stderr]);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "timed-out",
      exitCode: 143,
      signal: null,
      preflight: { status: "passed" },
    });

    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });

  it("lets manual cancellation end a post-exit pipe drain without a default timeout", async () => {
    const descendantPidPath = join(scratch, "cancel-descendant.pid");
    const modelExiting = join(scratch, "cancel-model.exiting");
    const input = options("claude", "cancel-drain");
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: {
        ...process.env,
        FAKE_DESCENDANT_HOLDS_PIPES_MS: "5000",
        FAKE_DESCENDANT_PID_PATH: descendantPidPath,
        FAKE_MODEL_EXITING_PATH: modelExiting,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();
    await waitFor(modelExiting);
    await waitForExit(Number(readFileSync(modelExiting, "utf8")));
    runner.kill("SIGTERM");

    expect(await exitWithin(runner, 2_000)).toBe(130);
    await Promise.all([stdout, stderr]);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "cancelled",
      exitCode: 0,
      signal: null,
      preflight: { status: "passed" },
      error: { message: "launcher received SIGTERM after child exited" },
    });

    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });

  it("clears a losing long-deadline timer when the shipped wrapper succeeds", async () => {
    const input = { ...options("claude", "long-deadline"), timeoutMs: 60_000 };
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();

    expect(await exitWithin(runner, 3_000)).toBe(0);
    await Promise.all([stdout, stderr]);
    expect(receipt(input.receiptPath).status).toBe("complete");
  });

  it("cancels a preflight with SIGINT and writes a terminal receipt", async () => {
    const input = options("claude", "preflight-cancelled");
    const started = join(scratch, "preflight-child.started");
    const terminated = join(scratch, "preflight-child.terminated");
    const isolatedRunner = join(scratch, "isolated-runner");
    cpSync(import.meta.dir, isolatedRunner, { recursive: true });
    const runner = Bun.spawn([
      process.execPath,
      join(isolatedRunner, "pstack-runner"),
      ...runnerArgs(input).slice(1),
    ], {
      cwd: scratch,
      env: {
        ...process.env,
        FAKE_CANCEL_STAGE: "preflight",
        FAKE_STARTED_PATH: started,
        FAKE_TERMINATED_PATH: terminated,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();
    await waitFor(started);
    runner.kill("SIGINT");

    expect(await exitWithin(runner, 3_000)).toBe(130);
    await Promise.all([stdout, stderr]);
    expect(readFileSync(terminated, "utf8")).toBe("SIGINT");
    expect(existsSync(input.outputPath)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "cancelled",
      signal: "SIGINT",
      preflight: { status: "cancelled" },
    });
  });

  it("reaps the child and exits after repeated cancellation with a long deadline", async () => {
    const input = { ...options("codex", "repeated-cancel"), timeoutMs: 60_000 };
    const started = join(scratch, "repeated-child.started");
    const terminated = join(scratch, "repeated-child.terminated");
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: {
        ...process.env,
        FAKE_CANCEL: "1",
        FAKE_IGNORE_SIGNAL: "1",
        FAKE_STARTED_PATH: started,
        FAKE_TERMINATED_PATH: terminated,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();
    await waitFor(started);
    const childPid = Number(readFileSync(started, "utf8"));
    runner.kill("SIGTERM");
    await Bun.sleep(100);
    runner.kill("SIGTERM");

    expect(await exitWithin(runner, 4_000)).toBe(130);
    await Promise.all([stdout, stderr]);
    expect(readFileSync(terminated, "utf8")).toBe("SIGTERM");
    expect(processIsAlive(childPid)).toBe(false);
    expect(existsSync(input.outputPath)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "cancelled",
      signal: "SIGTERM",
    });
  });

  it("forwards cancellation, preserves its receipt, and permits a new attempt", async () => {
    const input = options("codex", "cancelled");
    const started = join(scratch, "cancelled-child.started");
    const terminated = join(scratch, "cancelled-child.terminated");
    const env = {
      ...process.env,
      FAKE_CANCEL: "1",
      FAKE_STARTED_PATH: started,
      FAKE_TERMINATED_PATH: terminated,
    };
    const runner = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(runner.stdout).text();
    const stderr = new Response(runner.stderr).text();
    await waitFor(started);
    runner.kill("SIGTERM");

    expect(await runner.exited).toBe(130);
    await Promise.all([stdout, stderr]);
    expect(readFileSync(terminated, "utf8")).toBe("SIGTERM");
    expect(existsSync(input.outputPath)).toBe(false);
    expect(receipt(input.receiptPath)).toMatchObject({
      status: "cancelled",
      signal: "SIGTERM",
      exitCode: 0,
      error: { message: "launcher received SIGTERM; signal was sent to child" },
    });

    const samePaths = Bun.spawn([process.execPath, ...runnerArgs(input)], {
      cwd: scratch,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const sameStdout = new Response(samePaths.stdout).text();
    const sameStderr = new Response(samePaths.stderr).text();
    expect(await samePaths.exited).toBe(64);
    await Promise.all([sameStdout, sameStderr]);
    expect(receipt(input.receiptPath).status).toBe("cancelled");

    const retry = options("codex", "cancelled-retry");
    const result = await runLane(retry);
    expect(result.exitCode).toBe(0);
    expect(receipt(retry.receiptPath).status).toBe("complete");
  });

  it("reports a missing CLI without fabricating output", async () => {
    process.env.PATH = join(scratch, "empty-bin");
    mkdirSync(process.env.PATH);
    const input = options("grok");
    const result = await runLane(input);
    expect(result.exitCode).toBe(69);
    expect(existsSync(input.outputPath)).toBe(false);
    expect(receipt(input.receiptPath).status).toBe("unavailable-cli");
  });

  it("runs simultaneous same-provider lanes only into their unique paths", async () => {
    const first = options("grok", "first");
    const second = options("grok", "second");
    const results = await Promise.all([runLane(first), runLane(second)]);
    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(first.outputPath).not.toBe(second.outputPath);
    expect(receipt(first.receiptPath).sessionId).toBe("g1");
    expect(receipt(second.receiptPath).sessionId).toBe("g1");
  });

  it("refuses a second writer for an already-reserved path", async () => {
    const input = options("claude");
    writeFileSync(input.outputPath, "owned");
    await expect(runLane(input)).rejects.toThrow();
    expect(readFileSync(input.outputPath, "utf8")).toBe("owned");
    expect(existsSync(input.receiptPath)).toBe(false);
  });

  it("terminalizes catchable failures after reserving output paths", async () => {
    const unreadable = options("claude", "unreadable-prompt");
    chmodSync(unreadable.promptPath, 0o000);
    const unreadableRunner = Bun.spawn([process.execPath, ...runnerArgs(unreadable)], {
      cwd: scratch,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const unreadableStdout = new Response(unreadableRunner.stdout).text();
    const unreadableStderr = new Response(unreadableRunner.stderr).text();
    expect(await unreadableRunner.exited).toBe(70);
    await Promise.all([unreadableStdout, unreadableStderr]);
    chmodSync(unreadable.promptPath, 0o600);

    const preservedReceipt = readFileSync(unreadable.receiptPath, "utf8");
    expect(statSync(unreadable.receiptPath).size).toBeGreaterThan(0);
    expect(existsSync(unreadable.outputPath)).toBe(false);
    expect(receipt(unreadable.receiptPath)).toMatchObject({
      status: "child-failed",
      preflight: { status: "not-run" },
      error: { message: "launcher failed after reserving output paths" },
    });

    const samePaths = Bun.spawn([process.execPath, ...runnerArgs(unreadable)], {
      cwd: scratch,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const sameStdout = new Response(samePaths.stdout).text();
    const sameStderr = new Response(samePaths.stderr).text();
    expect(await samePaths.exited).toBe(64);
    await Promise.all([sameStdout, sameStderr]);
    expect(readFileSync(unreadable.receiptPath, "utf8")).toBe(preservedReceipt);

    const spawnFailure = options("claude", "spawn-failure");
    const modelStarted = join(scratch, "spawn-failure-model.started");
    const spawnRunner = Bun.spawn([process.execPath, ...runnerArgs(spawnFailure)], {
      cwd: scratch,
      env: {
        ...process.env,
        FAKE_REMOVE_EXECUTABLE_AFTER_PREFLIGHT: "1",
        FAKE_MODEL_STARTED_PATH: modelStarted,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const spawnStdout = new Response(spawnRunner.stdout).text();
    const spawnStderr = new Response(spawnRunner.stderr).text();
    expect(await spawnRunner.exited).toBe(70);
    await Promise.all([spawnStdout, spawnStderr]);
    expect(existsSync(modelStarted)).toBe(false);
    expect(existsSync(spawnFailure.outputPath)).toBe(false);
    expect(receipt(spawnFailure.receiptPath)).toMatchObject({
      status: "child-failed",
      preflight: { status: "passed" },
    });

    makeExecutable("claude");
    const retry = options("claude", "post-reservation-retry");
    expect((await runLane(retry)).exitCode).toBe(0);
    expect(receipt(retry.receiptPath).status).toBe("complete");
  });

  it("rejects same-provider recursion", async () => {
    const input = { ...options("claude"), parent: "claude" as const };
    await expect(runLane(input)).rejects.toThrow("native to parent");
  });
});

describe("childEnvironment", () => {
  it("removes only inherited runtime identity needed to avoid nested detection", () => {
    const source = {
      PATH: "/bin",
      CODEX_THREAD_ID: "codex",
      CODEX_CI: "1",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      KEEP_ME: "yes",
    };
    expect(childEnvironment("claude", source)).toEqual({
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      KEEP_ME: "yes",
    });
    expect(childEnvironment("codex", source)).toEqual({
      PATH: "/bin",
      CODEX_THREAD_ID: "codex",
      CODEX_CI: "1",
      KEEP_ME: "yes",
    });
    expect(childEnvironment("grok", source)).toEqual({
      PATH: "/bin",
      KEEP_ME: "yes",
    });
  });
});
