export const PARENTS = ["claude", "codex"] as const;
export const PROVIDERS = ["claude", "codex", "grok"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const ACCESS_MODES = ["read-only", "isolated-write"] as const;

export const MODEL_EFFORTS = {
  "claude:claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude:claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "codex:gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "codex:gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "codex:gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "grok:grok-4.6": ["low", "medium", "high", "xhigh", "max"],
} as const satisfies Record<string, readonly Effort[]>;

export type Parent = (typeof PARENTS)[number];
export type Provider = (typeof PROVIDERS)[number];
export type Effort = (typeof EFFORTS)[number];
export type AccessMode = (typeof ACCESS_MODES)[number];

export interface RunnerOptions {
  readonly parent: Parent;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: AccessMode;
  readonly promptPath: string;
  readonly cwd: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly timeoutMs: number | null;
  readonly managedAttempt: ManagedAttemptClaim | null;
}

export interface ManagedAttemptClaim {
  readonly laneId: string;
  readonly attemptId: string;
  readonly laneFingerprint: string;
  readonly promptSha256: string;
}

export interface VerifiedManagedAttempt extends ManagedAttemptClaim {
  readonly verified: true;
}

export interface UnverifiedManagedAttempt extends ManagedAttemptClaim {
  readonly verified: false;
  readonly reason: "prompt-unreadable" | "prompt-digest-mismatch" | "lane-fingerprint-mismatch";
}

export type ReceiptStatus =
  | "complete"
  | "provider-paused"
  | "cancelled"
  | "unavailable-cli"
  | "unauthenticated"
  | "unavailable-model"
  | "timed-out"
  | "child-failed"
  | "malformed-output";

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}

export interface ParsedOutput {
  readonly text: string;
  readonly reportedModel: string | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
}

export interface RunnerReceiptV1 {
  readonly schemaVersion: 1;
  readonly status: Exclude<ReceiptStatus, "provider-paused">;
  readonly parent: Parent;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: AccessMode;
  readonly cwd: string;
  readonly promptPath: string;
  readonly outputPath: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly executable: string | null;
  readonly preflight: {
    readonly argv: readonly string[];
    readonly status: "passed" | "failed" | "timed-out" | "cancelled" | "not-run";
    readonly evidence: string;
  };
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
  readonly error: {
    readonly message: string;
    readonly evidence: string;
  } | null;
}

export interface ClaudeSessionLimitPause {
  readonly kind: "claude-session-limit";
  readonly terminalReason: "api_error";
  readonly apiStatus: 429;
  readonly observedAt: string;
  readonly message: string;
  readonly resetEvidence: string;
}

export interface RunnerReceiptBaseV2 {
  readonly schemaVersion: 2;
  readonly parent: Parent;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: AccessMode;
  readonly cwd: string;
  readonly promptPath: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly timeoutMs: number | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly executable: string | null;
  readonly preflight: RunnerReceiptV1["preflight"];
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
}

export interface CompleteReceiptV2 extends RunnerReceiptBaseV2 {
  readonly status: "complete";
  readonly managedAttempt: VerifiedManagedAttempt | null;
  readonly providerPause: null;
  readonly error: null;
}

export interface ProviderPausedReceiptV2 extends RunnerReceiptBaseV2 {
  readonly status: "provider-paused";
  readonly provider: "claude";
  readonly managedAttempt: VerifiedManagedAttempt | null;
  readonly modelVerified: false;
  readonly modelEvidence: null;
  readonly providerPause: ClaudeSessionLimitPause;
  readonly error: null;
}

export interface FailureReceiptV2 extends RunnerReceiptBaseV2 {
  readonly status: Exclude<ReceiptStatus, "complete" | "provider-paused">;
  readonly managedAttempt: UnverifiedManagedAttempt | VerifiedManagedAttempt | null;
  readonly modelVerified: false;
  readonly modelEvidence: null;
  readonly providerPause: null;
  readonly error: {
    readonly message: string;
    readonly evidence: string;
  };
}

export type RunnerReceiptV2 =
  | CompleteReceiptV2
  | ProviderPausedReceiptV2
  | FailureReceiptV2;

export type RunnerReceipt = RunnerReceiptV1 | RunnerReceiptV2;

export class UsageError extends Error {}
