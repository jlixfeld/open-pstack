import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  ManagedAttemptClaim,
  RunnerOptions,
  UnverifiedManagedAttempt,
  VerifiedManagedAttempt,
} from "./types.ts";

type LaneFingerprintOptions = Pick<
  RunnerOptions,
  | "parent"
  | "provider"
  | "model"
  | "effort"
  | "mode"
  | "cwd"
  | "promptPath"
  | "timeoutMs"
>;

export function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function laneFingerprint(
  options: LaneFingerprintOptions,
  promptSha256: string
): string {
  return sha256Hex(JSON.stringify({
    parent: options.parent,
    provider: options.provider,
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    cwd: options.cwd,
    promptPath: options.promptPath,
    promptSha256,
    timeoutMs: options.timeoutMs,
  }));
}

export class ManagedIdentityError extends Error {
  readonly attempt: UnverifiedManagedAttempt;

  constructor(attempt: UnverifiedManagedAttempt) {
    super(`managed attempt identity could not be verified: ${attempt.reason}`);
    this.attempt = attempt;
  }
}

function identityFailure(
  claim: ManagedAttemptClaim,
  reason: UnverifiedManagedAttempt["reason"]
): ManagedIdentityError {
  return new ManagedIdentityError({ ...claim, verified: false, reason });
}

export interface PreparedPrompt {
  readonly prompt: string;
  readonly managedAttempt: VerifiedManagedAttempt | null;
}

export function preparePrompt(options: RunnerOptions): PreparedPrompt {
  let prompt: string;
  try {
    prompt = readFileSync(options.promptPath, "utf8");
  } catch {
    if (options.managedAttempt !== null) {
      throw identityFailure(options.managedAttempt, "prompt-unreadable");
    }
    throw new Error(`could not read prompt: ${options.promptPath}`);
  }
  if (options.managedAttempt === null) {
    return { prompt, managedAttempt: null };
  }

  const promptSha256 = sha256Hex(prompt);
  if (promptSha256 !== options.managedAttempt.promptSha256) {
    throw identityFailure(options.managedAttempt, "prompt-digest-mismatch");
  }
  if (laneFingerprint(options, promptSha256) !== options.managedAttempt.laneFingerprint) {
    throw identityFailure(options.managedAttempt, "lane-fingerprint-mismatch");
  }
  return {
    prompt,
    managedAttempt: { ...options.managedAttempt, verified: true },
  };
}
