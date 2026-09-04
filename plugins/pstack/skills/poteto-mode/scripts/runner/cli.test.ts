import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { parseArgs } from "./cli.ts";

function argv(extra: readonly string[] = []): string[] {
  return [
    "--parent",
    "claude",
    "--provider",
    "codex",
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "max",
    "--mode",
    "read-only",
    "--prompt",
    join(process.cwd(), "prompt.md"),
    "--cwd",
    process.cwd(),
    "--output",
    join(process.cwd(), "output.md"),
    "--receipt",
    join(process.cwd(), "receipt.json"),
    ...extra,
  ];
}

describe("runner CLI parsing", () => {
  it("does not invent a timeout", () => {
    expect(parseArgs(argv())?.timeoutMs).toBeNull();
  });

  it("honors an explicit positive timeout", () => {
    expect(parseArgs(argv(["--timeout", "5400"]))?.timeoutMs).toBe(5_400_000);
  });

  it("accepts managed identity only as one complete group", () => {
    const digest = "a".repeat(64);
    expect(parseArgs(argv([
      "--lane-id", "manifest-review-claude",
      "--attempt-id", "manifest-review-claude-000001",
      "--lane-fingerprint", digest,
      "--prompt-sha256", digest,
    ]))?.managedAttempt).toEqual({
      laneId: "manifest-review-claude",
      attemptId: "manifest-review-claude-000001",
      laneFingerprint: digest,
      promptSha256: digest,
    });
    expect(() => parseArgs(argv(["--lane-id", "manifest-review-claude"]))).toThrow(
      "must be provided together"
    );
    expect(() => parseArgs(argv([
      "--lane-id", "../escape",
      "--attempt-id", "attempt",
      "--lane-fingerprint", digest,
      "--prompt-sha256", digest,
    ]))).toThrow("lane-id must match");
  });

  it("normalizes every path before managed identity is checked", () => {
    const digest = "a".repeat(64);
    const parsed = parseArgs(argv([
      "--prompt", "prompt.md",
      "--cwd", ".",
      "--output", "output.md",
      "--receipt", "receipt.json",
      "--lane-id", "lane",
      "--attempt-id", "lane-000001",
      "--lane-fingerprint", digest,
      "--prompt-sha256", digest,
    ]));
    expect(parsed).toMatchObject({
      promptPath: resolve("prompt.md"),
      cwd: resolve("."),
      outputPath: resolve("output.md"),
      receiptPath: resolve("receipt.json"),
      managedAttempt: {
        laneId: "lane",
        attemptId: "lane-000001",
        laneFingerprint: digest,
        promptSha256: digest,
      },
    });
  });

  it("rejects a non-positive timeout", () => {
    expect(() => parseArgs(argv(["--timeout", "0"]))).toThrow(
      "greater than zero"
    );
  });

  it("rejects unsupported provider, model, and family effort combinations", () => {
    expect(() => parseArgs(argv(["--provider", "claude", "--model", "gpt-5.6-sol"]))).toThrow(
      "unsupported model or effort: claude:gpt-5.6-sol@max"
    );
    expect(() => parseArgs(argv(["--provider", "claude", "--model", "claude-fable-5"]))).toThrow(
      "unsupported model or effort: claude:claude-fable-5@max"
    );
    expect(() => parseArgs(argv(["--provider", "claude", "--model", "claude-opus-5", "--effort", "ultra"]))).toThrow(
      "unsupported model or effort: claude:claude-opus-5@ultra"
    );
    expect(() => parseArgs(argv(["--provider", "codex", "--model", "gpt-5.6-luna", "--effort", "ultra"]))).toThrow(
      "unsupported model or effort: codex:gpt-5.6-luna@ultra"
    );
  });
});
