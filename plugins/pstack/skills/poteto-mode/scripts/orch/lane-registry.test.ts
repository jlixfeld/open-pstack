import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneFingerprint } from "../runner/identity.ts";
import {
  laneArtifactPaths,
  laneSnapshotPath,
  parseLaneRegistry,
} from "./lane-registry.ts";
import { openStore, type Store } from "./store.ts";

const directories: string[] = [];
const stores: Store[] = [];
const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const UNIT_IDS = new Set(["unit"]);

async function fixture(): Promise<{
  readonly directory: string;
  readonly store: Store;
  readonly registered: any;
  readonly claimed: any;
}> {
  const directory = await mkdtemp(join(tmpdir(), "orch-registry-"));
  directories.push(directory);
  const store = openStore(directory, { now: () => NOW });
  stores.push(store);
  await store.init();
  await store.units.add({ id: "unit", track: "test" });
  const prompt = join(directory, "prompt.md");
  await writeFile(prompt, "review\n");
  await store.lanes.register({
    laneId: "review",
    unitId: "unit",
    parent: "codex",
    provider: "claude",
    model: "claude-opus-5",
    effort: "xhigh",
    mode: "read-only",
    promptPath: prompt,
    cwd: "/tmp",
  });
  const path = join(directory, "provider-lanes", "registry.json");
  const registered = JSON.parse(await readFile(path, "utf8"));
  await store.lanes.tick();
  const claimed = JSON.parse(await readFile(path, "utf8"));
  return { directory, store, registered, claimed };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function terminal(
  claimedRegistry: any,
  kind: "complete" | "provider-paused" | "failed" | "interrupted"
): any {
  const value = copy(claimedRegistry);
  const lane = value.lanes[0];
  const claim = lane.attempts.at(-1);
  const at = "2026-09-04T12:00:05.000Z";
  const row = kind === "complete"
    ? {
        ...claim,
        kind,
        completedAt: at,
        receiptSha256: "a".repeat(64),
        outputSha256: "b".repeat(64),
      }
    : kind === "provider-paused"
      ? {
          ...claim,
          kind,
          observedAt: at,
          nextAttemptAt: "2026-09-04T12:30:05.000Z",
          receiptSha256: "a".repeat(64),
          resetEvidence: "You've hit your session limit - resets later",
        }
      : kind === "failed"
        ? {
            ...claim,
            kind,
            completedAt: at,
            receiptSha256: "a".repeat(64),
          }
        : {
            ...claim,
            kind,
            interruptedAt: at,
            reason: "dead pid 12",
          };
  lane.attempts.push(row);
  return value;
}

async function rejectsWithoutMutation(
  directory: string,
  store: Store,
  value: unknown
): Promise<void> {
  const path = join(directory, "provider-lanes", "registry.json");
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, contents);
  await expect(store.lanes.tick()).rejects.toThrow("invalid shape");
  expect(await readFile(path, "utf8")).toBe(contents);
}

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) await store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("provider lane registry parsing", () => {
  it("accepts every legal attempt transition", async () => {
    const { directory, registered, claimed } = await fixture();
    expect(parseLaneRegistry(registered, directory, UNIT_IDS)).toEqual(registered);
    expect(parseLaneRegistry(claimed, directory, UNIT_IDS)).toEqual(claimed);
    for (const kind of [
      "complete",
      "provider-paused",
      "failed",
      "interrupted",
    ] as const) {
      const value = terminal(claimed, kind);
      expect(parseLaneRegistry(value, directory, UNIT_IDS)).toEqual(value);
    }
  });

  it("rejects corrupt roots, duplicate lanes, unsafe ids, enums, policy, and fingerprints", async () => {
    const { directory, store, registered } = await fixture();
    const cases: Array<readonly [string, (value: any) => unknown]> = [
      ["null root", () => null],
      ["wrong version", (value) => ({ ...value, schemaVersion: 2 })],
      ["extra root", (value) => ({ ...value, extra: true })],
      ["lanes not array", (value) => ({ ...value, lanes: {} })],
      ["duplicate lane id", (value) => ({ ...value, lanes: [value.lanes[0], value.lanes[0]] })],
      ["unsafe lane id", (value) => {
        value.lanes[0].spec.laneId = "../escape";
        return value;
      }],
      ["unsafe unit id", (value) => {
        value.lanes[0].spec.unitId = "bad.unit";
        return value;
      }],
      ["unknown unit id", (value) => {
        value.lanes[0].spec.unitId = "missing";
        return value;
      }],
      ["bad parent", (value) => {
        value.lanes[0].spec.parent = "other";
        return value;
      }],
      ["bad provider", (value) => {
        value.lanes[0].spec.provider = "other";
        return value;
      }],
      ["bad effort", (value) => {
        value.lanes[0].spec.effort = "infinite";
        return value;
      }],
      ["bad mode", (value) => {
        value.lanes[0].spec.mode = "write-anywhere";
        return value;
      }],
      ["bad model route", (value) => {
        value.lanes[0].spec.model = "gpt-5.6-sol";
        return value;
      }],
      ["same-provider route", (value) => {
        value.lanes[0].spec.parent = "claude";
        return value;
      }],
      ["bad interval", (value) => {
        value.lanes[0].spec.retryIntervalMs = 0;
        return value;
      }],
      ["interval below policy", (value) => {
        value.lanes[0].spec.retryIntervalMs = 1_799_000;
        return value;
      }],
      ["fractional interval", (value) => {
        value.lanes[0].spec.retryIntervalMs = 1_500;
        return value;
      }],
      ["bad timeout", (value) => {
        value.lanes[0].spec.timeoutMs = -1;
        return value;
      }],
      ["bad digest", (value) => {
        value.lanes[0].spec.promptSha256 = "nope";
        return value;
      }],
      ["bad fingerprint", (value) => {
        value.lanes[0].spec.laneFingerprint = "b".repeat(64);
        return value;
      }],
      ["extra spec", (value) => {
        value.lanes[0].spec.extra = true;
        return value;
      }],
    ];
    for (const [, mutate] of cases) {
      await rejectsWithoutMutation(directory, store, mutate(copy(registered)));
    }
  });

  it("rejects unresolved or escaping snapshot and artifact paths", async () => {
    const { directory, store, registered, claimed } = await fixture();
    const badPrompt = copy(registered);
    badPrompt.lanes[0].spec.promptPath = "/tmp/prompt.md";
    await rejectsWithoutMutation(directory, store, badPrompt);

    const relativeCwd = copy(registered);
    relativeCwd.lanes[0].spec.cwd = ".";
    await rejectsWithoutMutation(directory, store, relativeCwd);

    for (const field of ["outputPath", "receiptPath"] as const) {
      const badArtifact = copy(claimed);
      badArtifact.lanes[0].attempts.at(-1)[field] = "/tmp/escaped";
      await rejectsWithoutMutation(directory, store, badArtifact);
    }
  });

  it("rejects empty, malformed, duplicate, and illegal attempt histories", async () => {
    const { directory, store, registered, claimed } = await fixture();
    const cases: unknown[] = [];

    const empty = copy(registered);
    empty.lanes[0].attempts = [];
    cases.push(empty);

    const badFirst = copy(registered);
    badFirst.lanes[0].attempts[0] = { kind: "claimed" };
    cases.push(badFirst);

    const badRegisteredTime = copy(registered);
    badRegisteredTime.lanes[0].attempts[0].registeredAt = "today";
    cases.push(badRegisteredTime);

    const extraRegistered = copy(registered);
    extraRegistered.lanes[0].attempts[0].extra = true;
    cases.push(extraRegistered);

    const duplicateClaim = copy(claimed);
    duplicateClaim.lanes[0].attempts.push(copy(duplicateClaim.lanes[0].attempts.at(-1)));
    cases.push(duplicateClaim);

    const claimBeforeRegistration = copy(claimed);
    claimBeforeRegistration.lanes[0].attempts[1].claimedAt = "2026-09-04T11:59:59.000Z";
    cases.push(claimBeforeRegistration);

    const unknownKind = copy(claimed);
    unknownKind.lanes[0].attempts.at(-1).kind = "future";
    cases.push(unknownKind);

    const duplicateAttemptId = terminal(claimed, "interrupted");
    duplicateAttemptId.lanes[0].attempts.push({
      ...duplicateAttemptId.lanes[0].attempts[1],
      kind: "claimed",
    });
    cases.push(duplicateAttemptId);

    const retryBeforePauseDue = terminal(claimed, "provider-paused");
    const earlyAttemptId = "68d38f06-8f30-4aec-b05a-88f0b979d157";
    retryBeforePauseDue.lanes[0].attempts.push({
      kind: "claimed",
      attemptId: earlyAttemptId,
      claimedAt: "2026-09-04T12:30:04.999Z",
      ...laneArtifactPaths(directory, "review", earlyAttemptId),
    });
    cases.push(retryBeforePauseDue);

    const afterComplete = terminal(claimed, "complete");
    const oldClaim = afterComplete.lanes[0].attempts[1];
    const newAttemptId = "0f5c3945-f028-4d09-b955-cc35e8f1102a";
    afterComplete.lanes[0].attempts.push({
      ...oldClaim,
      kind: "claimed",
      attemptId: newAttemptId,
      ...laneArtifactPaths(directory, "review", newAttemptId),
    });
    cases.push(afterComplete);

    for (const value of cases) {
      await rejectsWithoutMutation(directory, store, value);
    }
  });

  it("rejects malformed status-specific fields and schedules", async () => {
    const { directory, store, claimed } = await fixture();
    const cases: unknown[] = [];

    const complete = terminal(claimed, "complete");
    const missingOutputDigest = copy(complete);
    delete missingOutputDigest.lanes[0].attempts.at(-1).outputSha256;
    cases.push(missingOutputDigest);
    const completedBeforeClaim = copy(complete);
    completedBeforeClaim.lanes[0].attempts.at(-1).completedAt = "2026-09-03T12:00:00.000Z";
    cases.push(completedBeforeClaim);

    const paused = terminal(claimed, "provider-paused");
    const shiftedSchedule = copy(paused);
    shiftedSchedule.lanes[0].attempts.at(-1).nextAttemptAt = "2026-09-04T12:31:05.000Z";
    cases.push(shiftedSchedule);
    const emptyReset = copy(paused);
    emptyReset.lanes[0].attempts.at(-1).resetEvidence = "";
    cases.push(emptyReset);

    const failed = terminal(claimed, "failed");
    const badFailureDigest = copy(failed);
    badFailureDigest.lanes[0].attempts.at(-1).receiptSha256 = "A".repeat(64);
    cases.push(badFailureDigest);

    const interrupted = terminal(claimed, "interrupted");
    const multilineReason = copy(interrupted);
    multilineReason.lanes[0].attempts.at(-1).reason = "dead\npid";
    cases.push(multilineReason);

    for (const value of cases) {
      await rejectsWithoutMutation(directory, store, value);
    }
  });

  it("rejects multiple current claims for one provider", async () => {
    const { directory, store, claimed } = await fixture();
    const value = copy(claimed);
    const original = value.lanes[0];
    const laneId = "second";
    const attemptId = "0f5c3945-f028-4d09-b955-cc35e8f1102a";
    const promptPath = laneSnapshotPath(directory, laneId);
    const specBase = {
      ...original.spec,
      laneId,
      promptPath,
    };
    const spec = {
      ...specBase,
      laneFingerprint: laneFingerprint(specBase, specBase.promptSha256),
    };
    value.lanes.push({
      spec,
      attempts: [
        { kind: "registered", registeredAt: "2026-09-04T12:00:00.000Z" },
        {
          kind: "claimed",
          attemptId,
          claimedAt: "2026-09-04T12:00:00.000Z",
          ...laneArtifactPaths(directory, laneId, attemptId),
        },
      ],
    });
    await rejectsWithoutMutation(directory, store, value);
  });

  it("rejects malformed JSON before scheduling or rewriting the registry", async () => {
    const { directory, store } = await fixture();
    const path = join(directory, "provider-lanes", "registry.json");
    const malformed = "{not-json\n";
    await writeFile(path, malformed);

    await expect(store.lanes.tick()).rejects.toThrow("not valid JSON");
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  it("rejects duplicate unit ids before scheduling", async () => {
    const { directory, store } = await fixture();
    const path = join(directory, "units.tsv");
    const contents = [
      "id\ttrack\tstate\tbranch\tpr\tsha\tbrief",
      "unit\ttest\tpending\t\t\t\t",
      "unit\ttest\tpending\t\t\t\t",
      "",
    ].join("\n");
    await writeFile(path, contents);

    await expect(store.lanes.tick()).rejects.toThrow(
      "units.tsv contains duplicate unit id unit"
    );
    expect(await readFile(path, "utf8")).toBe(contents);
  });
});
