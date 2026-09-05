import { describe, expect, expectTypeOf, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReceipt,
  finalizeReservation,
  parseRunnerReceipt,
  type CompleteModelProof,
  type ReceiptDetails,
} from "./receipt.ts";
import { invocationCommand, preflightCommand } from "./commands.ts";
import type {
  FailureReceiptStatus,
  RunnerOptions,
  RunnerReceiptV2,
  UnverifiedManagedAttempt,
  VerifiedManagedAttempt,
} from "./types.ts";

const digest = "a".repeat(64);

function options(provider: "claude" | "codex" = "claude"): RunnerOptions {
  return {
    parent: provider === "claude" ? "codex" : "claude",
    provider,
    model: provider === "claude" ? "claude-opus-5" : "gpt-5.6-sol",
    effort: "max",
    mode: "read-only",
    promptPath: "/tmp/prompt.md",
    cwd: "/tmp",
    outputPath: "/tmp/output.md",
    receiptPath: "/tmp/receipt.json",
    timeoutMs: null,
    managedAttempt: {
      laneId: "review-lane",
      attemptId: "e45b6f48-b750-4e32-b65b-18163240d90d",
      laneFingerprint: digest,
      promptSha256: digest,
    },
  };
}

function processDetails(input: RunnerOptions) {
  const executable = `/usr/local/bin/${input.provider}`;
  return {
    startedAt: "2026-09-04T12:00:00.000Z",
    completedAt: "2026-09-04T12:00:01.250Z",
    elapsedMs: 1_250,
    executable,
    preflight: {
      argv: [executable, ...preflightCommand(input.provider).args],
      status: "passed" as const,
      evidence: "authenticated",
    },
    argv: [executable, ...invocationCommand(input).args],
    exitCode: 0,
    signal: null,
  };
}

function completeReceipt(provider: "claude" | "codex" = "claude"): RunnerReceiptV2 {
  const input = options(provider);
  const modelProof = provider === "claude"
    ? {
        provider,
        reportedModel: "claude-opus-5-20260901",
        modelVerified: true as const,
        modelEvidence: "provider-report" as const,
      }
    : {
        provider,
        reportedModel: null,
        modelVerified: false as const,
        modelEvidence: "pinned-argv" as const,
      };
  return buildReceipt(input, {
    ...processDetails(input),
    status: "complete",
    modelProof,
    managedAttempt: { ...input.managedAttempt!, verified: true },
    outputSha256: digest,
    sessionId: "session-1",
    usage: { inputTokens: 10, outputTokens: 20 },
    costUsd: 0.25,
  });
}

function replace(
  receipt: RunnerReceiptV2,
  changes: Record<string, unknown>
): unknown {
  return { ...receipt, ...changes };
}

describe("receipt finalization", () => {
  it("requires valid model proof and verified managed identity for completion", () => {
    type CompleteDetails = Extract<ReceiptDetails, { status: "complete" }>;
    type ProviderProof = Extract<
      CompleteModelProof,
      { modelEvidence: "provider-report" }
    >;
    type PinnedProof = Extract<
      CompleteModelProof,
      { modelEvidence: "pinned-argv" }
    >;
    type CompleteReceipt = Extract<RunnerReceiptV2, { status: "complete" }>;
    type PausedReceipt = Extract<RunnerReceiptV2, { status: "provider-paused" }>;
    type FailureReceipt = Extract<RunnerReceiptV2, { status: FailureReceiptStatus }>;

    expectTypeOf<CompleteDetails["managedAttempt"]>().toEqualTypeOf<
      VerifiedManagedAttempt | null
    >();
    expectTypeOf<ProviderProof>().toMatchTypeOf<{
      provider: "claude" | "grok";
      reportedModel: string;
      modelVerified: true;
    }>();
    expectTypeOf<PinnedProof>().toMatchTypeOf<{
      provider: "codex";
      reportedModel: null;
      modelVerified: false;
    }>();
    expectTypeOf<CompleteDetails["outputSha256"]>().toEqualTypeOf<string>();
    expectTypeOf<CompleteReceipt["outputSha256"]>().toEqualTypeOf<string>();
    expectTypeOf<PausedReceipt["outputSha256"]>().toEqualTypeOf<null>();
    expectTypeOf<FailureReceipt["outputSha256"]>().toEqualTypeOf<null>();
  });

  it("removes its temporary file when atomic replacement fails", () => {
    const scratch = mkdtempSync(join(tmpdir(), "pstack-receipt-test-"));
    const reservation = join(scratch, "reserved");
    mkdirSync(reservation);
    try {
      expect(() => finalizeReservation(reservation, "terminal")).toThrow();
      expect(readdirSync(scratch)).toEqual(["reserved"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("runner receipt parsing", () => {
  it("accepts Claude build-qualified provider proof and Codex pinned argv proof", () => {
    const claude = completeReceipt("claude");
    const codex = completeReceipt("codex");

    expect(claude.outputSha256).toBe(digest);
    expect(codex.outputSha256).toBe(digest);
    expect(parseRunnerReceipt(claude)).toEqual(claude);
    expect(parseRunnerReceipt(codex)).toEqual(codex);
  });

  it("rejects legacy, partial, unknown, malformed-route, and wrong-command receipts", () => {
    const valid = completeReceipt();
    const cases: readonly unknown[] = [
      null,
      [],
      { schemaVersion: 1, status: "complete" },
      { schemaVersion: 2, status: "complete" },
      replace(valid, { status: "future-status" }),
      replace(valid, { parent: "claude" }),
      replace(valid, { model: "gpt-5.6-sol" }),
      replace(valid, { elapsedMs: 1_251 }),
      replace(valid, { argv: ["claude", "--wrong"] }),
      replace(valid, {
        preflight: { ...valid.preflight, argv: ["claude", "wrong"] },
      }),
      replace(valid, { extra: true }),
    ];

    for (const candidate of cases) {
      expect(parseRunnerReceipt(candidate)).toBeNull();
    }
  });

  it("rejects malformed managed identity, telemetry, timing, and status fields", () => {
    const valid = completeReceipt();
    const missingOutputDigest = { ...valid } as Record<string, unknown>;
    delete missingOutputDigest.outputSha256;
    const cases: readonly unknown[] = [
      replace(valid, { startedAt: "yesterday" }),
      replace(valid, { completedAt: "2026-09-04T11:59:59.000Z" }),
      replace(valid, { executable: "" }),
      replace(valid, {
        executable: "claude",
        argv: ["claude", ...invocationCommand(options()).args],
        preflight: {
          ...valid.preflight,
          argv: ["claude", ...preflightCommand("claude").args],
        },
      }),
      replace(valid, {
        executable: "/usr/local/bin/codex",
        argv: ["/usr/local/bin/codex", ...invocationCommand(options()).args],
        preflight: {
          ...valid.preflight,
          argv: ["/usr/local/bin/codex", ...preflightCommand("claude").args],
        },
      }),
      replace(valid, { exitCode: null }),
      replace(valid, { signal: 9 }),
      replace(valid, { usage: { inputTokens: -1 } }),
      replace(valid, { usage: { inputTokens: 1, otherTokens: 2 } }),
      replace(valid, { costUsd: Number.NaN }),
      missingOutputDigest,
      replace(valid, { outputSha256: null }),
      replace(valid, { outputSha256: "A".repeat(64) }),
      replace(valid, { managedAttempt: { verified: true } }),
      replace(valid, {
        managedAttempt: {
          ...valid.managedAttempt,
          verified: false,
          reason: "made-up",
        },
      }),
      replace(valid, { providerPause: {} }),
      replace(valid, { error: { message: "failure", evidence: "" } }),
    ];

    for (const candidate of cases) {
      expect(parseRunnerReceipt(candidate)).toBeNull();
    }
  });

  it("accepts a wall-clock span at least as long as the monotonic elapsed time", () => {
    const valid = completeReceipt();
    const laterCompletedAt = "2026-09-04T13:00:01.250Z";
    const jumpedForward = replace(valid, { completedAt: laterCompletedAt });

    expect(parseRunnerReceipt(jumpedForward)?.completedAt).toBe(laterCompletedAt);
    expect(parseRunnerReceipt(replace(valid, { elapsedMs: 1_251 }))).toBeNull();
    expect(parseRunnerReceipt(replace(valid, {
      completedAt: laterCompletedAt,
      elapsedMs: 3_601_251,
    }))).toBeNull();
    expect(parseRunnerReceipt(replace(valid, { completedAt: valid.startedAt }))).toBeNull();
  });

  it("rejects an otherwise consistent receipt with an uppercase managed lane id", () => {
    const input = options("claude");
    if (input.managedAttempt === null) throw new Error("missing managed attempt");
    const managedAttempt = { ...input.managedAttempt, laneId: "Review" };
    const uppercase: RunnerOptions = {
      ...input,
      managedAttempt,
    };
    const value = buildReceipt(uppercase, {
      ...processDetails(uppercase),
      status: "complete",
      modelProof: {
        provider: "claude",
        reportedModel: "claude-opus-5-20260901",
        modelVerified: true,
        modelEvidence: "provider-report",
      },
      managedAttempt: { ...managedAttempt, verified: true },
      outputSha256: digest,
      sessionId: "session-1",
      usage: { inputTokens: 10 },
      costUsd: 0.25,
    });

    expect(parseRunnerReceipt(value)).toBeNull();
  });

  it("requires exact provider-specific completion proof", () => {
    const claude = completeReceipt("claude");
    const codex = completeReceipt("codex");
    const cases: readonly unknown[] = [
      replace(claude, { reportedModel: "claude-opus-4" }),
      replace(claude, { modelVerified: false }),
      replace(claude, { modelEvidence: "pinned-argv" }),
      replace(codex, { reportedModel: "gpt-5.6-sol" }),
      replace(codex, { modelVerified: true }),
      replace(codex, { modelEvidence: "provider-report" }),
    ];

    for (const candidate of cases) {
      expect(parseRunnerReceipt(candidate)).toBeNull();
    }
  });

  it("accepts a complete Claude pause and rejects forged pause metadata", () => {
    const input = options("claude");
    const paused = buildReceipt(input, {
      ...processDetails(input),
      status: "provider-paused",
      provider: "claude",
      reportedModel: "claude-opus-5-20260901",
      managedAttempt: { ...input.managedAttempt!, verified: true },
      sessionId: "session-1",
      usage: { inputTokens: 10 },
      costUsd: 0.25,
      providerPause: {
        kind: "claude-session-limit",
        terminalReason: "api_error",
        apiStatus: 429,
        observedAt: "2026-09-04T12:00:01.250Z",
        message: "You've hit your session limit - resets soon",
        resetEvidence: "You've hit your session limit - resets soon",
      },
    });

    expect(paused.outputSha256).toBeNull();
    expect(parseRunnerReceipt(paused)).toEqual(paused);
    const observedAfterJump = replace(paused, {
      completedAt: "2026-09-04T13:00:01.250Z",
      providerPause: { ...paused.providerPause, observedAt: "2026-09-04T13:00:01.250Z" },
    });
    expect(parseRunnerReceipt(observedAfterJump)?.completedAt).toBe(
      "2026-09-04T13:00:01.250Z"
    );
    expect(parseRunnerReceipt(replace(paused, { outputSha256: digest }))).toBeNull();
    for (const providerPause of [
      {},
      { ...paused.providerPause, observedAt: "later" },
      { ...paused.providerPause, observedAt: "2026-09-04T12:00:02.000Z" },
      { ...paused.providerPause, apiStatus: 503 },
      { ...paused.providerPause, terminalReason: "rate_limit" },
      { ...paused.providerPause, message: "generic 429" },
      { ...paused.providerPause, resetEvidence: "different" },
    ]) {
      expect(parseRunnerReceipt(replace(paused, { providerPause }))).toBeNull();
    }
  });

  it("accepts only internally consistent failure receipts", () => {
    const input = options("claude");
    const failed = buildReceipt(input, {
      ...processDetails(input),
      exitCode: 1,
      status: "child-failed",
      provider: "claude",
      managedAttempt: { ...input.managedAttempt!, verified: true },
      error: { message: "child exited with status 1", evidence: "boom" },
    });
    const unavailable = buildReceipt(input, {
      ...processDetails(input),
      status: "unavailable-cli",
      provider: "claude",
      managedAttempt: { ...input.managedAttempt!, verified: true },
      executable: null,
      preflight: {
        argv: ["claude", ...preflightCommand("claude").args],
        status: "not-run",
        evidence: "",
      },
      argv: ["claude", ...invocationCommand(input).args],
      exitCode: null,
      signal: null,
      error: { message: "claude executable not found", evidence: "" },
    });

    expect(failed.outputSha256).toBeNull();
    expect(unavailable.outputSha256).toBeNull();
    expect(parseRunnerReceipt(failed)).toEqual(failed);
    expect(parseRunnerReceipt(unavailable)).toEqual(unavailable);
    expect(parseRunnerReceipt(replace(failed, { error: null }))).toBeNull();
    expect(parseRunnerReceipt(replace(unavailable, { executable: "/bin/claude" }))).toBeNull();
    expect(parseRunnerReceipt(replace(unavailable, {
      preflight: { ...unavailable.preflight, status: "passed" },
    }))).toBeNull();
  });

  it("accepts every producer-consistent failure status and rejects impossible combinations", () => {
    const input = options("claude");
    const executable = "/usr/local/bin/claude";
    const verified = { ...input.managedAttempt!, verified: true as const };
    const unverified: UnverifiedManagedAttempt = {
      ...input.managedAttempt!,
      verified: false,
      reason: "prompt-digest-mismatch",
    };
    const error = { message: "runner failed", evidence: "evidence" };
    const makeFailure = (
      status: FailureReceiptStatus,
      changes: Record<string, unknown> = {},
      managedAttempt: VerifiedManagedAttempt | UnverifiedManagedAttempt = verified
    ): RunnerReceiptV2 => buildReceipt(input, {
      ...processDetails(input),
      exitCode: 1,
      status,
      provider: "claude",
      managedAttempt,
      error,
      ...changes,
    });

    const preflightFailure = {
      argv: [executable, ...preflightCommand("claude").args],
      status: "failed" as const,
      evidence: "not logged in",
    };
    const beforeChild = (status: "cancelled" | "timed-out") => ({
      executable,
      preflight: {
        argv: ["claude", ...preflightCommand("claude").args],
        status,
        evidence: "",
      },
      argv: [executable, ...invocationCommand(input).args],
      exitCode: null,
      signal: null,
    });
    const receipts = [
      makeFailure("child-failed"),
      makeFailure("unauthenticated", { preflight: preflightFailure }),
      makeFailure("unavailable-model"),
      makeFailure("malformed-output", { exitCode: 0 }),
      makeFailure("cancelled", beforeChild("cancelled"), unverified),
      makeFailure("timed-out", beforeChild("timed-out"), unverified),
    ];
    for (const receipt of receipts) {
      expect(parseRunnerReceipt(receipt)).toEqual(receipt);
    }

    expect(parseRunnerReceipt(replace(receipts[0]!, { exitCode: 0 }))).toBeNull();
    expect(parseRunnerReceipt(replace(receipts[2]!, { exitCode: 0 }))).toBeNull();
    expect(parseRunnerReceipt(replace(receipts[3]!, { exitCode: 1 }))).toBeNull();
    expect(parseRunnerReceipt(replace(receipts[4]!, {
      preflight: preflightFailure,
    }))).toBeNull();
    expect(parseRunnerReceipt(replace(receipts[2]!, {
      managedAttempt: unverified,
    }))).toBeNull();
  });
});
