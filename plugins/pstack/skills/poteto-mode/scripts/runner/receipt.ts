import {
  existsSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { invocationCommand, preflightCommand } from "./commands.ts";
import { isClaudeSessionLimitMessage, reportedModelMatches } from "./parse-output.ts";
import {
  ACCESS_MODES,
  EFFORTS,
  PARENTS,
  PROVIDERS,
  RECEIPT_STATUSES,
} from "./types.ts";
import type {
  ClaudeSessionLimitPause,
  CompleteReceiptV2,
  FailureReceiptStatus,
  Provider,
  RunnerOptions,
  RunnerReceipt,
  RunnerReceiptBaseV2,
  RunnerReceiptV2,
  NormalizedUsage,
  UnverifiedManagedAttempt,
  VerifiedManagedAttempt,
} from "./types.ts";
import {
  SAFE_ID_PATTERN,
  SHA256_PATTERN,
  validateRunnerRoute,
} from "./validation.ts";

type ProcessDetails = Pick<
  RunnerReceiptBaseV2,
  | "startedAt"
  | "completedAt"
  | "elapsedMs"
  | "executable"
  | "preflight"
  | "argv"
  | "exitCode"
  | "signal"
>;

type TelemetryDetails = Pick<
  RunnerReceiptBaseV2,
  "sessionId" | "usage" | "costUsd"
>;

type ModelProofFields =
  | "provider"
  | "reportedModel"
  | "modelVerified"
  | "modelEvidence";

export type CompleteModelProof =
  | Pick<
      Extract<CompleteReceiptV2, { modelEvidence: "provider-report" }>,
      ModelProofFields
    >
  | Pick<
      Extract<CompleteReceiptV2, { modelEvidence: "pinned-argv" }>,
      ModelProofFields
    >;

type CompleteReceiptDetails = ProcessDetails & TelemetryDetails & {
  readonly status: "complete";
  readonly modelProof: CompleteModelProof;
  readonly managedAttempt: VerifiedManagedAttempt | null;
};

type ProviderPausedReceiptDetails = ProcessDetails & TelemetryDetails & {
  readonly status: "provider-paused";
  readonly provider: "claude";
  readonly reportedModel: string | null;
  readonly providerPause: ClaudeSessionLimitPause;
  readonly managedAttempt: VerifiedManagedAttempt | null;
};

type FailureReceiptDetails = ProcessDetails & {
  readonly status: FailureReceiptStatus;
  readonly provider: Provider;
  readonly managedAttempt: UnverifiedManagedAttempt | VerifiedManagedAttempt | null;
  readonly error: NonNullable<RunnerReceiptV2["error"]>;
};

export type ReceiptDetails =
  | CompleteReceiptDetails
  | ProviderPausedReceiptDetails
  | FailureReceiptDetails;

export function buildReceipt(
  options: RunnerOptions,
  details: ReceiptDetails
): RunnerReceiptV2 {
  const common = {
    schemaVersion: 2 as const,
    parent: options.parent,
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    cwd: options.cwd,
    promptPath: options.promptPath,
    outputPath: options.outputPath,
    receiptPath: options.receiptPath,
    timeoutMs: options.timeoutMs,
    startedAt: details.startedAt,
    completedAt: details.completedAt,
    elapsedMs: details.elapsedMs,
    executable: details.executable,
    preflight: details.preflight,
    argv: details.argv,
    exitCode: details.exitCode,
    signal: details.signal,
  };

  switch (details.status) {
    case "complete":
      return {
        ...common,
        ...details.modelProof,
        status: "complete",
        managedAttempt: details.managedAttempt,
        sessionId: details.sessionId,
        usage: details.usage,
        costUsd: details.costUsd,
        providerPause: null,
        error: null,
      };
    case "provider-paused":
      return {
        ...common,
        status: "provider-paused",
        provider: details.provider,
        managedAttempt: details.managedAttempt,
        reportedModel: details.reportedModel,
        modelVerified: false,
        modelEvidence: null,
        sessionId: details.sessionId,
        usage: details.usage,
        costUsd: details.costUsd,
        providerPause: details.providerPause,
        error: null,
      };
    default:
      return {
        ...common,
        status: details.status,
        provider: details.provider,
        managedAttempt: details.managedAttempt,
        reportedModel: null,
        modelVerified: false,
        modelEvidence: null,
        sessionId: null,
        usage: null,
        costUsd: null,
        providerPause: null,
        error: details.error,
      };
  }
}

export function finalizeReservation(path: string, contents: string): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

export function finalizeReceipt(path: string, receipt: RunnerReceipt): void {
  finalizeReservation(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

type JsonRecord = Readonly<Record<string, unknown>>;

const RECEIPT_KEYS = [
  "schemaVersion",
  "status",
  "parent",
  "provider",
  "model",
  "effort",
  "mode",
  "cwd",
  "promptPath",
  "outputPath",
  "receiptPath",
  "timeoutMs",
  "startedAt",
  "completedAt",
  "elapsedMs",
  "executable",
  "preflight",
  "argv",
  "exitCode",
  "signal",
  "reportedModel",
  "modelVerified",
  "modelEvidence",
  "sessionId",
  "usage",
  "costUsd",
  "managedAttempt",
  "providerPause",
  "error",
] as const;

const PREFLIGHT_STATUSES = [
  "passed",
  "failed",
  "timed-out",
  "cancelled",
  "not-run",
] as const;

const IDENTITY_FAILURE_REASONS = [
  "prompt-unreadable",
  "prompt-digest-mismatch",
  "lane-fingerprint-mismatch",
] as const;

const USAGE_KEYS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

const invalid = Symbol("invalid");
type Invalid = typeof invalid;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  return choices.find((candidate) => candidate === value) ?? null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null | Invalid {
  return value === null ? null : nonEmptyString(value) ?? invalid;
}

function absolutePath(value: unknown): string | null {
  const path = nonEmptyString(value);
  return path !== null && resolve(path) === path ? path : null;
}

function instant(value: unknown): { readonly value: string; readonly milliseconds: number } | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  try {
    if (new Date(milliseconds).toISOString() !== value) return null;
  } catch {
    return null;
  }
  return { value, milliseconds };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function nullableNonNegativeInteger(value: unknown): number | null | Invalid {
  return value === null ? null : nonNegativeInteger(value) ?? invalid;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const result: string[] = [];
  for (const item of value) {
    const entry = nonEmptyString(item);
    if (entry === null) return null;
    result.push(entry);
  }
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function optionalToken(value: JsonRecord, key: string): number | undefined | Invalid {
  if (!Object.hasOwn(value, key)) return undefined;
  return nonNegativeInteger(value[key]) ?? invalid;
}

function usage(value: unknown): NormalizedUsage | null | Invalid {
  if (value === null) return null;
  const input = record(value);
  if (
    input === null ||
    Object.keys(input).length === 0 ||
    Object.keys(input).some(
      (key) => !USAGE_KEYS.some((candidate) => candidate === key)
    )
  ) {
    return invalid;
  }
  const inputTokens = optionalToken(input, "inputTokens");
  const cachedInputTokens = optionalToken(input, "cachedInputTokens");
  const cacheCreationInputTokens = optionalToken(input, "cacheCreationInputTokens");
  const outputTokens = optionalToken(input, "outputTokens");
  const reasoningTokens = optionalToken(input, "reasoningTokens");
  const totalTokens = optionalToken(input, "totalTokens");
  if (
    inputTokens === invalid ||
    cachedInputTokens === invalid ||
    cacheCreationInputTokens === invalid ||
    outputTokens === invalid ||
    reasoningTokens === invalid ||
    totalTokens === invalid
  ) {
    return invalid;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function managedAttempt(
  value: unknown
): VerifiedManagedAttempt | UnverifiedManagedAttempt | null | Invalid {
  if (value === null) return null;
  const input = record(value);
  if (input === null) return invalid;
  const laneId = nonEmptyString(input.laneId);
  const attemptId = nonEmptyString(input.attemptId);
  const laneFingerprint = nonEmptyString(input.laneFingerprint);
  const promptSha256 = nonEmptyString(input.promptSha256);
  if (
    laneId === null ||
    attemptId === null ||
    laneFingerprint === null ||
    promptSha256 === null ||
    !SAFE_ID_PATTERN.test(laneId) ||
    !SAFE_ID_PATTERN.test(attemptId) ||
    !SHA256_PATTERN.test(laneFingerprint) ||
    !SHA256_PATTERN.test(promptSha256)
  ) {
    return invalid;
  }
  if (input.verified === true) {
    if (!hasExactKeys(input, [
      "laneId",
      "attemptId",
      "laneFingerprint",
      "promptSha256",
      "verified",
    ])) return invalid;
    return { laneId, attemptId, laneFingerprint, promptSha256, verified: true };
  }
  if (input.verified === false) {
    if (!hasExactKeys(input, [
      "laneId",
      "attemptId",
      "laneFingerprint",
      "promptSha256",
      "verified",
      "reason",
    ])) return invalid;
    const reason = choice(input.reason, IDENTITY_FAILURE_REASONS);
    if (reason === null) return invalid;
    return { laneId, attemptId, laneFingerprint, promptSha256, verified: false, reason };
  }
  return invalid;
}

function pauseEvidence(
  value: unknown,
  completedAt: string
): ClaudeSessionLimitPause | null {
  const input = record(value);
  if (
    input === null ||
    !hasExactKeys(input, [
      "kind",
      "terminalReason",
      "apiStatus",
      "observedAt",
      "message",
      "resetEvidence",
    ]) ||
    input.kind !== "claude-session-limit" ||
    input.terminalReason !== "api_error" ||
    input.apiStatus !== 429 ||
    input.observedAt !== completedAt
  ) {
    return null;
  }
  const message = nonEmptyString(input.message);
  const resetEvidence = nonEmptyString(input.resetEvidence);
  if (
    message === null ||
    resetEvidence === null ||
    resetEvidence !== message ||
    !isClaudeSessionLimitMessage(message)
  ) {
    return null;
  }
  return {
    kind: "claude-session-limit",
    terminalReason: "api_error",
    apiStatus: 429,
    observedAt: completedAt,
    message,
    resetEvidence,
  };
}

function receiptError(value: unknown): NonNullable<RunnerReceiptV2["error"]> | null {
  const input = record(value);
  if (input === null || !hasExactKeys(input, ["message", "evidence"])) return null;
  const message = nonEmptyString(input.message);
  if (
    message === null ||
    message.length > 4_000 ||
    typeof input.evidence !== "string" ||
    input.evidence.length > 4_000
  ) {
    return null;
  }
  return { message, evidence: input.evidence };
}

export function parseRunnerReceipt(value: unknown): RunnerReceiptV2 | null {
  const input = record(value);
  if (input === null || !hasExactKeys(input, RECEIPT_KEYS) || input.schemaVersion !== 2) {
    return null;
  }

  const status = choice(input.status, RECEIPT_STATUSES);
  const parent = choice(input.parent, PARENTS);
  const provider = choice(input.provider, PROVIDERS);
  const effort = choice(input.effort, EFFORTS);
  const mode = choice(input.mode, ACCESS_MODES);
  const model = nonEmptyString(input.model);
  const cwd = absolutePath(input.cwd);
  const promptPath = absolutePath(input.promptPath);
  const outputPath = absolutePath(input.outputPath);
  const receiptPath = absolutePath(input.receiptPath);
  if (
    status === null ||
    parent === null ||
    provider === null ||
    effort === null ||
    mode === null ||
    model === null ||
    cwd === null ||
    promptPath === null ||
    outputPath === null ||
    receiptPath === null ||
    promptPath === outputPath ||
    promptPath === receiptPath ||
    outputPath === receiptPath
  ) {
    return null;
  }

  const timeoutMs = input.timeoutMs === null
    ? null
    : typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : invalid;
  const started = instant(input.startedAt);
  const completed = instant(input.completedAt);
  const elapsedMs = nonNegativeInteger(input.elapsedMs);
  const executable = input.executable === null
    ? null
    : absolutePath(input.executable) ?? invalid;
  const exitCode = nullableNonNegativeInteger(input.exitCode);
  const signal = input.signal === null
    ? null
    : choice(input.signal, ["SIGINT", "SIGTERM"] as const) ?? invalid;
  const reportedModel = nullableString(input.reportedModel);
  const sessionId = nullableString(input.sessionId);
  const parsedUsage = usage(input.usage);
  const costUsd = input.costUsd === null
    ? null
    : typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0
      ? input.costUsd
      : invalid;
  const parsedManaged = managedAttempt(input.managedAttempt);
  if (
    timeoutMs === invalid ||
    started === null ||
    completed === null ||
    elapsedMs === null ||
    completed.milliseconds < started.milliseconds ||
    elapsedMs !== completed.milliseconds - started.milliseconds ||
    executable === invalid ||
    exitCode === invalid ||
    signal === invalid ||
    reportedModel === invalid ||
    sessionId === invalid ||
    parsedUsage === invalid ||
    costUsd === invalid ||
    parsedManaged === invalid ||
    typeof input.modelVerified !== "boolean"
  ) {
    return null;
  }
  if (executable !== null && basename(executable) !== provider) return null;

  try {
    validateRunnerRoute({
      parent,
      provider,
      model,
      effort,
      managed: parsedManaged !== null,
    });
  } catch {
    return null;
  }

  const preflightInput = record(input.preflight);
  if (preflightInput === null || !hasExactKeys(preflightInput, ["argv", "status", "evidence"])) {
    return null;
  }
  const preflightArgv = stringArray(preflightInput.argv);
  const preflightStatus = choice(preflightInput.status, PREFLIGHT_STATUSES);
  const argv = stringArray(input.argv);
  if (
    preflightArgv === null ||
    preflightStatus === null ||
    typeof preflightInput.evidence !== "string" ||
    preflightInput.evidence.length > 4_000 ||
    argv === null
  ) {
    return null;
  }
  if (
    (preflightStatus === "not-run" && preflightInput.evidence !== "") ||
    (preflightStatus === "passed" && (executable === null || preflightInput.evidence.length === 0))
  ) {
    return null;
  }

  const commandOptions: RunnerOptions = {
    parent,
    provider,
    model,
    effort,
    mode,
    cwd,
    promptPath,
    outputPath,
    receiptPath,
    timeoutMs,
    managedAttempt: parsedManaged === null
      ? null
      : {
          laneId: parsedManaged.laneId,
          attemptId: parsedManaged.attemptId,
          laneFingerprint: parsedManaged.laneFingerprint,
          promptSha256: parsedManaged.promptSha256,
        },
  };
  const expectedExecutable = executable ?? invocationCommand(commandOptions).command;
  const expectedArgv = [expectedExecutable, ...invocationCommand(commandOptions).args];
  const preflightSpec = preflightCommand(provider);
  const expectedResolvedPreflight = [
    executable ?? preflightSpec.command,
    ...preflightSpec.args,
  ];
  const expectedUnresolvedPreflight = [preflightSpec.command, ...preflightSpec.args];
  const preflightCommandMatches = sameStrings(
    preflightArgv,
    expectedResolvedPreflight
  ) || (
    preflightStatus !== "passed" &&
    preflightStatus !== "failed" &&
    sameStrings(preflightArgv, expectedUnresolvedPreflight)
  );
  if (!sameStrings(argv, expectedArgv) || !preflightCommandMatches) {
    return null;
  }

  const preflight = {
    argv: preflightArgv,
    status: preflightStatus,
    evidence: preflightInput.evidence,
  };
  const common = {
    schemaVersion: 2 as const,
    parent,
    provider,
    model,
    effort,
    mode,
    cwd,
    promptPath,
    outputPath,
    receiptPath,
    timeoutMs,
    startedAt: started.value,
    completedAt: completed.value,
    elapsedMs,
    executable,
    preflight,
    argv,
    exitCode,
    signal,
    sessionId,
    usage: parsedUsage,
    costUsd,
  };

  if (status === "complete") {
    if (
      (parsedManaged !== null && parsedManaged.verified !== true) ||
      preflightStatus !== "passed" ||
      executable === null ||
      exitCode !== 0 ||
      signal !== null ||
      input.providerPause !== null ||
      input.error !== null
    ) {
      return null;
    }
    if (provider === "codex") {
      if (
        reportedModel !== null ||
        input.modelVerified !== false ||
        input.modelEvidence !== "pinned-argv"
      ) {
        return null;
      }
      return {
        ...common,
        status,
        provider,
        managedAttempt: parsedManaged,
        reportedModel: null,
        modelVerified: false,
        modelEvidence: "pinned-argv",
        providerPause: null,
        error: null,
      };
    }
    if (
      reportedModel === null ||
      !reportedModelMatches(model, reportedModel) ||
      input.modelVerified !== true ||
      input.modelEvidence !== "provider-report"
    ) {
      return null;
    }
    return {
      ...common,
      status,
      provider,
      managedAttempt: parsedManaged,
      reportedModel,
      modelVerified: true,
      modelEvidence: "provider-report",
      providerPause: null,
      error: null,
    };
  }

  if (status === "provider-paused") {
    const providerPause = pauseEvidence(input.providerPause, completed.value);
    if (
      provider !== "claude" ||
      (parsedManaged !== null && parsedManaged.verified !== true) ||
      preflightStatus !== "passed" ||
      executable === null ||
      exitCode === null ||
      signal !== null ||
      input.modelVerified !== false ||
      input.modelEvidence !== null ||
      input.error !== null ||
      providerPause === null
    ) {
      return null;
    }
    return {
      ...common,
      status,
      provider,
      managedAttempt: parsedManaged,
      reportedModel,
      modelVerified: false,
      modelEvidence: null,
      providerPause,
      error: null,
    };
  }

  const error = receiptError(input.error);
  if (
    input.providerPause !== null ||
    input.modelVerified !== false ||
    input.modelEvidence !== null ||
    reportedModel !== null ||
    sessionId !== null ||
    parsedUsage !== null ||
    costUsd !== null ||
    error === null
  ) {
    return null;
  }
  if (
    parsedManaged !== null &&
    parsedManaged.verified === false &&
    status !== "child-failed" &&
    status !== "cancelled" &&
    status !== "timed-out"
  ) {
    return null;
  }
  if (
    status === "unavailable-cli" &&
    (executable !== null ||
      preflightStatus !== "not-run" ||
      exitCode !== null ||
      signal !== null)
  ) {
    return null;
  }
  if (
    status === "malformed-output" &&
    (preflightStatus !== "passed" || executable === null || exitCode !== 0 || signal !== null)
  ) {
    return null;
  }
  if (
    status === "cancelled" &&
    preflightStatus !== "cancelled" &&
    preflightStatus !== "passed"
  ) {
    return null;
  }
  if (
    status === "timed-out" &&
    preflightStatus !== "timed-out" &&
    preflightStatus !== "passed"
  ) {
    return null;
  }
  if (
    (status === "unauthenticated" || status === "unavailable-model") &&
    (executable === null ||
      (preflightStatus !== "failed" && preflightStatus !== "passed") ||
      exitCode === null ||
      signal !== null ||
      (preflightStatus === "passed" && exitCode === 0))
  ) {
    return null;
  }
  if (
    status === "child-failed" &&
    (preflightStatus === "cancelled" ||
      preflightStatus === "timed-out" ||
      signal !== null ||
      (preflightStatus === "passed" && exitCode === 0))
  ) {
    return null;
  }
  return {
    ...common,
    status,
    managedAttempt: parsedManaged,
    reportedModel: null,
    modelVerified: false,
    modelEvidence: null,
    sessionId: null,
    usage: null,
    costUsd: null,
    providerPause: null,
    error,
  };
}
