import {
  existsSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  ClaudeSessionLimitPause,
  CompleteReceiptV2,
  FailureReceiptStatus,
  Provider,
  RunnerOptions,
  RunnerReceipt,
  RunnerReceiptBaseV2,
  RunnerReceiptV2,
  UnverifiedManagedAttempt,
  VerifiedManagedAttempt,
} from "./types.ts";

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
