import { existsSync, statSync } from "node:fs";
import type { Effort, RunnerOptions } from "./types.ts";
import { MODEL_EFFORTS, UsageError } from "./types.ts";

export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type RunnerRoute = Pick<
  RunnerOptions,
  "parent" | "provider" | "model" | "effort"
> & {
  readonly managed: boolean;
};

function supportedEfforts(provider: string, model: string): readonly Effort[] | null {
  const key = `${provider}:${model}`;
  const entry = Object.entries(MODEL_EFFORTS).find(([candidate]) => candidate === key);
  return entry?.[1] ?? null;
}

export function validateSafeId(value: string, label: string): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new UsageError(
      `${label} must match ${SAFE_ID_PATTERN.source}`
    );
  }
  return value;
}

export function validateSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new UsageError(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

export function validateRunnerRoute(route: RunnerRoute): void {
  if (route.model.trim().length === 0) {
    throw new UsageError("model must not be empty");
  }
  const efforts = supportedEfforts(route.provider, route.model);
  if (efforts === null || !efforts.includes(route.effort)) {
    throw new UsageError(
      `unsupported model or effort: ${route.provider}:${route.model}@${route.effort}`
    );
  }
  if (route.parent === route.provider) {
    throw new UsageError(
      `provider ${route.provider} is native to parent ${route.parent}; use the parent subagent primitive`
    );
  }
  if (route.provider === "grok" && route.managed) {
    throw new UsageError(
      "managed Grok attempts are unsupported because Grok cannot consume verified prompt bytes"
    );
  }
}

export function validateRunnerTimeout(timeoutMs: number | null): void {
  if (
    timeoutMs !== null &&
    (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new UsageError("timeout must be greater than zero");
  }
}

export function validateExistingDirectory(path: string, label: string = "cwd"): void {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new UsageError(`${label} is not a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${label} is not a directory: ${path}`);
  }
}

function validateExistingFile(path: string, label: string): void {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new UsageError(`${label} is not a file: ${path}`);
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${label} is not a file: ${path}`);
  }
}

export function validateRunnerOptions(options: RunnerOptions): void {
  validateRunnerRoute({
    parent: options.parent,
    provider: options.provider,
    model: options.model,
    effort: options.effort,
    managed: options.managedAttempt !== null,
  });
  validateRunnerTimeout(options.timeoutMs);
  validateExistingFile(options.promptPath, "prompt");
  validateExistingDirectory(options.cwd);

  if (
    options.promptPath === options.outputPath ||
    options.promptPath === options.receiptPath ||
    options.outputPath === options.receiptPath
  ) {
    throw new UsageError("prompt, output, and receipt paths must be distinct");
  }

  const managed = options.managedAttempt;
  if (managed !== null) {
    validateSafeId(managed.laneId, "lane-id");
    validateSafeId(managed.attemptId, "attempt-id");
    validateSha256(managed.laneFingerprint, "lane-fingerprint");
    validateSha256(managed.promptSha256, "prompt-sha256");
  }
}
