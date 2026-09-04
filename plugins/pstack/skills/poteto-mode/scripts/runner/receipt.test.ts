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
  finalizeReservation,
  type CompleteModelProof,
  type ReceiptDetails,
} from "./receipt.ts";
import type { VerifiedManagedAttempt } from "./types.ts";

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
