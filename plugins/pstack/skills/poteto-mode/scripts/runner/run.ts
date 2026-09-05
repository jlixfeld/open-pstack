import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { invocationCommand, preflightCommand, type CommandSpec } from "./commands.ts";
import { ManagedIdentityError, preparePrompt, sha256Hex } from "./identity.ts";
import {
  parseClaudePauseTelemetry,
  parseClaudeSessionLimit,
  parseProviderOutput,
  reportedModelMatches,
} from "./parse-output.ts";
import {
  buildReceipt,
  finalizeReceipt,
  finalizeReservation,
  type CompleteModelProof,
} from "./receipt.ts";
import type {
  FailureReceiptStatus,
  Provider,
  ReceiptStatus,
  RunnerOptions,
  RunnerReceipt,
  VerifiedManagedAttempt,
} from "./types.ts";
import { UsageError } from "./types.ts";
import { validateRunnerOptions } from "./validation.ts";

const ERROR_EVIDENCE_LIMIT = 4_000;
const GROK_PREFLIGHT_RETRY_DELAY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelledBy: CancellationSignal | null;
}

type CancellationSignal = "SIGINT" | "SIGTERM";

interface RunCancellation {
  readonly promise: Promise<CancellationSignal>;
  readonly signal: CancellationSignal | null;
  dispose(): void;
}

type RetryWaitResult = "ready" | "cancelled" | "timed-out";

export interface RunResult {
  readonly exitCode: number;
  readonly receipt: RunnerReceipt;
}

function evidence(value: string): string {
  return value.trim().slice(0, ERROR_EVIDENCE_LIMIT);
}

function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function reserve(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
}

function reserveOutputs(options: RunnerOptions): void {
  if (options.outputPath === options.receiptPath) {
    throw new UsageError("output and receipt paths must differ");
  }
  reserve(options.outputPath);
  try {
    reserve(options.receiptPath);
  } catch (error) {
    removeIfExists(options.outputPath);
    throw error;
  }
}

function installRunCancellation(): RunCancellation {
  let signal: CancellationSignal | null = null;
  let resolveCancellation!: (value: CancellationSignal) => void;
  const promise = new Promise<CancellationSignal>((resolve) => {
    resolveCancellation = resolve;
  });

  const receive = (next: CancellationSignal): void => {
    if (signal === null) {
      signal = next;
      resolveCancellation(next);
    }
  };
  const onInterrupt = (): void => receive("SIGINT");
  const onTerminate = (): void => receive("SIGTERM");
  globalThis.process.on("SIGINT", onInterrupt);
  globalThis.process.on("SIGTERM", onTerminate);

  return {
    promise,
    get signal() {
      return signal;
    },
    dispose() {
      globalThis.process.off("SIGINT", onInterrupt);
      globalThis.process.off("SIGTERM", onTerminate);
    },
  };
}

const CODEX_IDENTITY = [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CI",
  "CODEX_SHELL",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
] as const;

const CLAUDE_IDENTITY = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const;

export function childEnvironment(
  provider: Provider,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result = { ...source };
  const remove = provider === "claude"
    ? CODEX_IDENTITY
    : provider === "codex"
      ? CLAUDE_IDENTITY
      : [...CODEX_IDENTITY, ...CLAUDE_IDENTITY];
  for (const key of remove) delete result[key];
  return result;
}

async function terminate(
  child: Bun.Subprocess,
  signal: CancellationSignal = "SIGTERM"
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  child.kill(signal);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let exited: boolean;
  try {
    exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
  } finally {
    if (graceTimer !== null) clearTimeout(graceTimer);
  }
  if (!exited) {
    child.kill("SIGKILL");
    await child.exited;
  }
  return true;
}

interface StreamCapture {
  readonly result: Promise<string>;
  cancel(): Promise<void>;
}

function captureStream(stream: ReadableStream<Uint8Array>): StreamCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let cancellationRequested = false;

  const result = (async (): Promise<string> => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      text += decoder.decode();
      if (!cancellationRequested) throw error;
      return text;
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    result,
    async cancel() {
      cancellationRequested = true;
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed and its reader released.
      }
    },
  };
}

type ProcessEvent =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "cancelled"; readonly signal: CancellationSignal }
  | { readonly kind: "timed-out" };

async function runProcess(
  executable: string,
  spec: CommandSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string | Uint8Array,
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<ProcessResult> {
  const child = Bun.spawn([executable, ...spec.args], {
    cwd,
    env,
    stdin: spec.stdin === "prompt" ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const stdoutCapture = captureStream(child.stdout);
  const stderrCapture = captureStream(child.stderr);
  const streams = Promise.all([stdoutCapture.result, stderrCapture.result]);
  const exited = child.exited.then((exitCode): ProcessEvent => ({
    kind: "exited",
    exitCode,
  }));
  const cancelled = cancellation.promise.then((signal): ProcessEvent => ({
    kind: "cancelled",
    signal,
  }));
  const deadline: Promise<ProcessEvent> | null = deadlineAt === null
    ? null
    : new Promise((resolve) => {
      const arm = (): void => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          resolve({ kind: "timed-out" });
          return;
        }
        deadlineTimer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      };
      arm();
    });
  try {
    if (spec.stdin === "prompt") {
      const stdin = child.stdin;
      if (stdin === undefined) throw new Error("child stdin pipe was not created");
      stdin.write(prompt);
      stdin.end();
    }

    const completions = [exited, cancelled];
    if (deadline !== null) completions.push(deadline);
    const first = await Promise.race(completions);

    let outcome = first;
    let captured: readonly [string, string] | null = null;
    let signalSent: CancellationSignal | null = null;

    if (first.kind === "exited") {
      const drains: Array<Promise<
        | { readonly kind: "drained"; readonly captured: readonly [string, string] }
        | ProcessEvent
      >> = [
        streams.then((value) => ({ kind: "drained" as const, captured: value })),
        cancelled,
      ];
      if (deadline !== null) drains.push(deadline);
      const drain = await Promise.race(drains);
      if (drain.kind === "drained") {
        captured = drain.captured;
        if (deadlineAt !== null && Date.now() >= deadlineAt) {
          outcome = { kind: "timed-out" };
        }
      } else {
        outcome = drain;
      }
    }

    const cancelledBy = cancellation.signal;
    const timedOut = cancelledBy === null && outcome.kind === "timed-out";
    if (cancelledBy !== null) {
      if (await terminate(child, cancelledBy)) signalSent = cancelledBy;
    } else if (timedOut) {
      if (await terminate(child)) signalSent = "SIGTERM";
    }
    if (captured === null) {
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
      captured = await streams;
    }

    return {
      exitCode: await child.exited,
      signal: signalSent,
      stdout: captured[0],
      stderr: captured[1],
      timedOut,
      cancelledBy,
    };
  } catch (error) {
    await terminate(child, cancellation.signal ?? "SIGTERM");
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    await Promise.allSettled([stdoutCapture.result, stderrCapture.result]);
    throw error;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

async function waitForGrokPreflightRetry(
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<RetryWaitResult> {
  if (cancellation.signal !== null) return "cancelled";

  const now = Date.now();
  if (deadlineAt !== null && now >= deadlineAt) return "timed-out";

  const retryAt = now + GROK_PREFLIGHT_RETRY_DELAY_MS;
  const wakeAt = deadlineAt === null ? retryAt : Math.min(retryAt, deadlineAt);
  const timerResult: RetryWaitResult = wakeAt < retryAt ? "timed-out" : "ready";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      cancellation.promise.then((): RetryWaitResult => "cancelled"),
      new Promise<RetryWaitResult>((resolve) => {
        timer = setTimeout(() => resolve(timerResult), wakeAt - now);
      }),
    ]);
    if (cancellation.signal !== null) return "cancelled";
    if (deadlineAt !== null && Date.now() >= deadlineAt) return "timed-out";
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function successfulPreflightEvidence(provider: Provider, model: string): string {
  return provider === "grok"
    ? `authenticated; model ${model} available`
    : "authenticated";
}

type ClassifiedFailureStatus = Extract<
  ReceiptStatus,
  "unauthenticated" | "unavailable-model" | "child-failed"
>;

type PreflightAssessment =
  | { readonly kind: "passed" }
  | {
      readonly kind: "failed";
      readonly receiptStatus: ClassifiedFailureStatus;
    };

function unavailableStatus(value: string): ClassifiedFailureStatus {
  if (/not logged in|unauthenticated|authentication|sign in|login required/i.test(value)) {
    return "unauthenticated";
  }
  if (/model.{0,40}(not found|unknown|unavailable|unsupported|not supported|invalid)|invalid.{0,20}model/i.test(value)) {
    return "unavailable-model";
  }
  return "child-failed";
}

function assessPreflight(
  provider: Provider,
  model: string,
  result: ProcessResult
): PreflightAssessment {
  const combined = `${result.stdout}\n${result.stderr}`;
  const failureEvidence = evidence(combined);
  switch (provider) {
    case "claude": {
      try {
        const value: unknown = JSON.parse(result.stdout);
        if (value !== null && typeof value === "object" && "loggedIn" in value) {
          if (value.loggedIn === false) {
            return { kind: "failed", receiptStatus: "unauthenticated" };
          }
          if (
            value.loggedIn === true &&
            result.exitCode === 0 &&
            !result.timedOut
          ) {
            return { kind: "passed" };
          }
        }
      } catch {}
      return { kind: "failed", receiptStatus: "child-failed" };
    }
    case "codex": {
      if (result.exitCode === 0 && !result.timedOut && /logged in/i.test(combined)) {
        return { kind: "passed" };
      }
      const status = unavailableStatus(failureEvidence);
      return {
        kind: "failed",
        receiptStatus: status === "child-failed" ? "unauthenticated" : status,
      };
    }
    case "grok": {
      if (
        result.exitCode === 0 &&
        !result.timedOut &&
        /logged in/i.test(combined) &&
        combined.includes(model)
      ) {
        return { kind: "passed" };
      }
      const status = unavailableStatus(failureEvidence);
      return {
        kind: "failed",
        receiptStatus: status === "child-failed"
          ? failureEvidence.includes(model)
            ? "unauthenticated"
            : "unavailable-model"
          : status,
      };
    }
  }
}

function retriedPreflightEvidence(
  first: string,
  second: string,
  secondPassed: boolean
): string {
  const firstLabel = "attempt 1 failed:\n";
  const secondLabel = `\n\nattempt 2 ${secondPassed ? "passed" : "failed"}:\n`;
  const payloadLimit = ERROR_EVIDENCE_LIMIT - firstLabel.length - secondLabel.length;
  const firstLimit = Math.floor(payloadLimit / 2);
  const secondLimit = payloadLimit - firstLimit;
  return `${firstLabel}${first.slice(0, firstLimit)}${secondLabel}${second.slice(0, secondLimit)}`;
}

function statusExitCode(status: ReceiptStatus): number {
  switch (status) {
    case "complete":
      return 0;
    case "provider-paused":
      return 75;
    case "cancelled":
      return 130;
    case "malformed-output":
      return 65;
    case "unavailable-cli":
    case "unavailable-model":
      return 69;
    case "child-failed":
      return 70;
    case "unauthenticated":
      return 77;
    case "timed-out":
      return 124;
  }
}

function modelProof(
  provider: Provider,
  requested: string,
  reported: string | null
): CompleteModelProof | null {
  if (
    provider !== "codex" &&
    reported !== null &&
    reportedModelMatches(requested, reported)
  ) {
    return {
      provider,
      reportedModel: reported,
      modelVerified: true,
      modelEvidence: "provider-report",
    };
  }
  if (provider === "codex" && reported === null) {
    return {
      provider,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
    };
  }
  return null;
}

interface LaneProgress {
  executable: string | null;
  preflight: RunnerReceipt["preflight"];
  argv: readonly string[];
}

async function executeLane(
  options: RunnerOptions,
  cancellation: RunCancellation,
  started: number,
  deadlineAt: number | null,
  invocation: CommandSpec,
  preflight: CommandSpec,
  progress: LaneProgress,
  prompt: Uint8Array,
  managedAttempt: VerifiedManagedAttempt | null
): Promise<RunResult> {
  const startedAt = new Date(started).toISOString();
  const env = childEnvironment(options.provider);
  const executable = Bun.which(invocation.command, {
    PATH: env.PATH,
    cwd: options.cwd,
  });
  progress.executable = executable;
  progress.argv = [executable ?? invocation.command, ...invocation.args];

  let preflightState = progress.preflight;
  let receipt: RunnerReceipt;

  const finishWithoutChild = (
    status: "cancelled" | "timed-out",
    phase: string
  ): RunResult => {
    const completed = Date.now();
    const receivedSignal = status === "cancelled" ? cancellation.signal : null;
    const terminalPreflight = preflightState.status === "not-run"
      ? { ...preflightState, status }
      : preflightState;
    receipt = buildReceipt(options, {
      status,
      provider: options.provider,
      managedAttempt,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: terminalPreflight,
      argv: [executable ?? invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      error: {
        message: receivedSignal === null
          ? `explicit deadline elapsed ${phase}`
          : `launcher received ${receivedSignal} ${phase}`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    finalizeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  };

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before authentication preflight");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before authentication preflight");
  }

  if (executable === null) {
    const completed = Date.now();
    receipt = buildReceipt(options, {
      status: "unavailable-cli",
      provider: options.provider,
      managedAttempt,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable: null,
      preflight: preflightState,
      argv: [invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      error: {
        message: `${invocation.command} executable not found`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    finalizeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(receipt.status), receipt };
  }

  const preflightExecutable = executable;
  let preflightResult = await runProcess(
    preflightExecutable,
    preflight,
    options.cwd,
    env,
    "",
    deadlineAt,
    cancellation
  );
  let rawPreflightEvidence = evidence(`${preflightResult.stdout}\n${preflightResult.stderr}`);
  let preflightAssessment = assessPreflight(
    options.provider,
    options.model,
    preflightResult
  );
  let preflightEvidence = preflightAssessment.kind === "passed"
    ? successfulPreflightEvidence(options.provider, options.model)
    : rawPreflightEvidence;

  if (
    options.provider === "grok" &&
    preflightAssessment.kind === "failed" &&
    preflightResult.cancelledBy === null &&
    !preflightResult.timedOut &&
    preflightAssessment.receiptStatus === "unauthenticated"
  ) {
    preflightState = {
      argv: [preflightExecutable, ...preflight.args],
      status: "failed",
      evidence: rawPreflightEvidence,
    };
    progress.preflight = preflightState;

    const retryWait = await waitForGrokPreflightRetry(deadlineAt, cancellation);
    if (retryWait !== "ready") {
      preflightState = {
        ...preflightState,
        status: retryWait === "cancelled" ? "cancelled" : "timed-out",
      };
      progress.preflight = preflightState;
      return finishWithoutChild(
        retryWait === "cancelled" ? "cancelled" : "timed-out",
        "during authentication preflight retry delay"
      );
    }

    const firstPreflightEvidence = rawPreflightEvidence;
    preflightResult = await runProcess(
      preflightExecutable,
      preflight,
      options.cwd,
      env,
      "",
      deadlineAt,
      cancellation
    );
    rawPreflightEvidence = evidence(`${preflightResult.stdout}\n${preflightResult.stderr}`);
    preflightAssessment = assessPreflight(
      options.provider,
      options.model,
      preflightResult
    );
    const secondPassed = preflightAssessment.kind === "passed";
    preflightEvidence = retriedPreflightEvidence(
      firstPreflightEvidence,
      secondPassed
        ? successfulPreflightEvidence(options.provider, options.model)
        : rawPreflightEvidence,
      secondPassed
    );
  }

  preflightState = {
    argv: [preflightExecutable, ...preflight.args],
    status: preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : preflightAssessment.kind === "passed"
          ? "passed"
          : "failed",
    evidence: preflightEvidence,
  };
  progress.preflight = preflightState;

  if (preflightState.status !== "passed") {
    const completed = Date.now();
    const preflightFailure = preflightAssessment.kind === "failed"
      ? preflightAssessment.receiptStatus
      : "child-failed";
    const status: FailureReceiptStatus = preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : preflightFailure;
    receipt = buildReceipt(options, {
      status,
      provider: options.provider,
      managedAttempt,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: preflightState,
      argv: [executable, ...invocation.args],
      exitCode: preflightResult.exitCode,
      signal: preflightResult.signal,
      error: {
        message: preflightResult.cancelledBy !== null
          ? `launcher received ${preflightResult.cancelledBy} during preflight`
          : preflightResult.timedOut
            ? "authentication preflight timed out"
            : "authentication or model preflight failed",
        evidence: preflightEvidence,
      },
    });
    removeIfExists(options.outputPath);
    finalizeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before model execution");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before model execution");
  }

  const result = await runProcess(
    executable,
    invocation,
    options.cwd,
    env,
    prompt,
    deadlineAt,
    cancellation
  );
  const completed = Date.now();
  const base = {
    startedAt,
    completedAt: new Date(completed).toISOString(),
    elapsedMs: completed - started,
    executable,
    preflight: preflightState,
    argv: [executable, ...invocation.args],
    exitCode: result.exitCode,
    signal: result.signal,
  } as const;

  if (
    options.provider === "claude" &&
    result.cancelledBy === null &&
    !result.timedOut
  ) {
    const pause = parseClaudeSessionLimit(result.stdout, base.completedAt);
    if (pause !== null) {
      const telemetry = parseClaudePauseTelemetry(result.stdout, options.model);
      receipt = buildReceipt(options, {
        ...base,
        status: "provider-paused",
        provider: options.provider,
        managedAttempt,
        reportedModel: telemetry?.reportedModel ?? null,
        sessionId: telemetry?.sessionId ?? null,
        usage: telemetry?.usage ?? null,
        costUsd: telemetry?.costUsd ?? null,
        providerPause: pause,
      });
      removeIfExists(options.outputPath);
      finalizeReceipt(options.receiptPath, receipt);
      return { exitCode: statusExitCode(receipt.status), receipt };
    }
  }

  if (result.cancelledBy !== null || result.timedOut || result.exitCode !== 0) {
    const rawFailureEvidence = `${result.stderr}\n${result.stdout}`;
    const failureEvidence = evidence(rawFailureEvidence);
    const status: FailureReceiptStatus = result.cancelledBy !== null
      ? "cancelled"
      : result.timedOut
        ? "timed-out"
        : unavailableStatus(rawFailureEvidence);
    receipt = buildReceipt(options, {
      ...base,
      status,
      provider: options.provider,
      managedAttempt,
      error: {
        message: result.cancelledBy !== null
          ? result.signal === result.cancelledBy
            ? `launcher received ${result.cancelledBy}; signal was sent to child`
            : `launcher received ${result.cancelledBy} after child exited`
          : result.timedOut
            ? `launcher exceeded the explicit ${options.timeoutMs}ms deadline`
            : `child exited with status ${result.exitCode}`,
        evidence: failureEvidence,
      },
    });
    removeIfExists(options.outputPath);
    finalizeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  try {
    const parsed = parseProviderOutput(
      options.provider,
      result.stdout,
      result.stderr,
      options.model
    );
    const proof = modelProof(
      options.provider,
      options.model,
      parsed.reportedModel
    );
    if (proof === null) {
      throw new Error(
        `requested model ${options.model} was not reported by ${options.provider}`
      );
    }
    const output = new TextEncoder().encode(parsed.text);
    finalizeReservation(options.outputPath, output);
    receipt = buildReceipt(options, {
      ...base,
      status: "complete",
      modelProof: proof,
      managedAttempt,
      outputSha256: sha256Hex(output),
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      costUsd: parsed.costUsd,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    removeIfExists(options.outputPath);
    receipt = buildReceipt(options, {
      ...base,
      status: "malformed-output",
      provider: options.provider,
      managedAttempt,
      error: {
        message: evidence(message) || "provider output could not be parsed",
        evidence: evidence(`${result.stderr}\n${result.stdout}`),
      },
    });
  }

  finalizeReceipt(options.receiptPath, receipt);
  return { exitCode: statusExitCode(receipt.status), receipt };
}

export async function runLane(
  input: RunnerOptions,
  started: number = Date.now()
): Promise<RunResult> {
  const options = resolvedOptions(input);
  validateRunnerOptions(options);
  const deadlineAt = options.timeoutMs === null ? null : started + options.timeoutMs;
  const invocation = invocationCommand(options);
  const preflight = preflightCommand(options.provider);
  const progress: LaneProgress = {
    executable: null,
    preflight: {
      argv: [preflight.command, ...preflight.args],
      status: "not-run",
      evidence: "",
    },
    argv: [invocation.command, ...invocation.args],
  };
  const cancellation = installRunCancellation();
  let verifiedManagedAttempt: VerifiedManagedAttempt | null = null;
  try {
    reserveOutputs(options);
    try {
      const prepared = preparePrompt(options);
      verifiedManagedAttempt = prepared.managedAttempt;
      return await executeLane(
        options,
        cancellation,
        started,
        deadlineAt,
        invocation,
        preflight,
        progress,
        prepared.prompt,
        prepared.managedAttempt
      );
    } catch (error) {
      const completed = Date.now();
      const signal = cancellation.signal;
      const status: FailureReceiptStatus = signal !== null
        ? "cancelled"
        : deadlineAt !== null && completed >= deadlineAt
          ? "timed-out"
          : "child-failed";
      const message = error instanceof Error ? error.message : String(error);
      const terminalPreflight = progress.preflight.status === "not-run" && status !== "child-failed"
        ? { ...progress.preflight, status }
        : progress.preflight;
      const receipt = buildReceipt(options, {
        status,
        provider: options.provider,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
        executable: progress.executable,
        preflight: terminalPreflight,
        argv: progress.argv,
        exitCode: null,
        signal: null,
        managedAttempt: error instanceof ManagedIdentityError
          ? error.attempt
          : verifiedManagedAttempt,
        error: {
          message: status === "cancelled"
            ? `launcher received ${signal} after reserving output paths`
            : status === "timed-out"
              ? "explicit deadline elapsed after reserving output paths"
              : "launcher failed after reserving output paths",
          evidence: evidence(message),
        },
      });
      removeIfExists(options.outputPath);
      finalizeReceipt(options.receiptPath, receipt);
      return { exitCode: statusExitCode(status), receipt };
    }
  } finally {
    cancellation.dispose();
  }
}

export function resolvedOptions(options: RunnerOptions): RunnerOptions {
  return {
    ...options,
    promptPath: resolve(options.promptPath),
    cwd: resolve(options.cwd),
    outputPath: resolve(options.outputPath),
    receiptPath: resolve(options.receiptPath),
  };
}
