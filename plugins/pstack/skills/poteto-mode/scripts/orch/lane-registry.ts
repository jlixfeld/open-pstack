import {
  readFile,
  readdir,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { laneFingerprint, sha256Hex } from "../runner/identity.ts";
import {
  ACCESS_MODES,
  EFFORTS,
  PARENTS,
  PROVIDERS,
  type AccessMode,
  type Effort,
  type Parent,
  type Provider,
} from "../runner/types.ts";
import {
  SAFE_ID_PATTERN,
  SAFE_LANE_ID_PATTERN,
  SHA256_PATTERN,
  validateRunnerRoute,
} from "../runner/validation.ts";
import { UserError } from "./errors.ts";
import {
  errorCode,
  pathExists,
  writeFileAtomically,
} from "./filesystem.ts";

export { pathExists } from "./filesystem.ts";

export interface LaneSpec {
  readonly laneId: string;
  readonly unitId: string;
  readonly parent: Parent;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: AccessMode;
  readonly promptPath: string;
  readonly cwd: string;
  readonly promptSha256: string;
  readonly timeoutMs: number | null;
  readonly retryIntervalMs: number;
  readonly laneFingerprint: string;
}

export interface RegisteredAttempt {
  readonly kind: "registered";
  readonly registeredAt: string;
}

export interface ClaimedAttempt {
  readonly kind: "claimed";
  readonly attemptId: string;
  readonly claimedAt: string;
  readonly outputPath: string;
  readonly receiptPath: string;
}

type ClaimedFields = Omit<ClaimedAttempt, "kind">;

export interface CompleteAttempt extends ClaimedFields {
  readonly kind: "complete";
  readonly completedAt: string;
  readonly receiptSha256: string;
  readonly outputSha256: string;
}

export interface PausedAttempt extends ClaimedFields {
  readonly kind: "provider-paused";
  readonly observedAt: string;
  readonly nextAttemptAt: string;
  readonly receiptSha256: string;
  readonly resetEvidence: string;
}

export interface FailedAttempt extends ClaimedFields {
  readonly kind: "failed";
  readonly completedAt: string;
  readonly receiptSha256: string;
}

export interface InterruptedAttempt extends ClaimedFields {
  readonly kind: "interrupted";
  readonly interruptedAt: string;
  readonly reason: string;
}

export type LaneAttempt =
  | RegisteredAttempt
  | ClaimedAttempt
  | CompleteAttempt
  | PausedAttempt
  | FailedAttempt
  | InterruptedAttempt;

export interface Lane {
  readonly spec: LaneSpec;
  readonly attempts: readonly LaneAttempt[];
}

export interface LaneRegistry {
  readonly schemaVersion: 1;
  readonly lanes: readonly Lane[];
}

export const MINIMUM_RETRY_INTERVAL_MS = 30 * 60 * 1_000;

type JsonRecord = Readonly<Record<string, unknown>>;

const SPEC_KEYS = [
  "laneId",
  "unitId",
  "parent",
  "provider",
  "model",
  "effort",
  "mode",
  "promptPath",
  "cwd",
  "promptSha256",
  "timeoutMs",
  "retryIntervalMs",
  "laneFingerprint",
] as const;

const CLAIM_KEYS = [
  "kind",
  "attemptId",
  "claimedAt",
  "outputPath",
  "receiptPath",
] as const;

const NO_TERMINAL_UNITS: ReadonlySet<string> = new Set();

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalid(detail: string): never {
  throw new UserError(`provider lane registry has an invalid shape: ${detail}`);
}

function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string
): T {
  if (typeof value !== "string") invalid(label);
  const result = choices.find((candidate) => candidate === value);
  return result ?? invalid(label);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(label);
  return value;
}

function safeId(value: unknown, label: string): string {
  const result = string(value, label);
  return SAFE_ID_PATTERN.test(result) ? result : invalid(label);
}

function safeLaneId(value: unknown, label: string): string {
  const result = string(value, label);
  return SAFE_LANE_ID_PATTERN.test(result) ? result : invalid(label);
}

function digest(value: unknown, label: string): string {
  return typeof value === "string" && SHA256_PATTERN.test(value)
    ? value
    : invalid(label);
}

function instant(value: unknown, label: string): { readonly value: string; readonly milliseconds: number } {
  if (typeof value !== "string") invalid(label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid(label);
  try {
    if (new Date(milliseconds).toISOString() !== value) invalid(label);
  } catch {
    invalid(label);
  }
  return { value, milliseconds };
}

function positiveMilliseconds(value: unknown, label: string): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value % 1_000 === 0
    ? value
    : invalid(label);
}

function timeout(value: unknown): number | null {
  return value === null ? null : positiveMilliseconds(value, "timeoutMs");
}

function absolutePath(value: unknown, label: string): string {
  const path = string(value, label);
  return resolve(path) === path ? path : invalid(label);
}

export function providerLanesRoot(store: string): string {
  return resolve(store, "provider-lanes");
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child.length > 0 &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child);
}

function derivedPath(root: string, pieces: readonly string[]): string {
  const path = resolve(root, ...pieces);
  if (!contained(root, path)) invalid("derived path escapes provider-lanes root");
  return path;
}

export function laneSnapshotPath(store: string, laneId: string): string {
  return derivedPath(providerLanesRoot(store), [laneId, "prompt.md"]);
}

export function laneArtifactPaths(
  store: string,
  laneId: string,
  attemptId: string
): { readonly outputPath: string; readonly receiptPath: string } {
  const root = providerLanesRoot(store);
  return {
    outputPath: derivedPath(root, [laneId, "attempts", `${attemptId}.output.md`]),
    receiptPath: derivedPath(root, [laneId, "attempts", `${attemptId}.receipt.json`]),
  };
}

export function laneRegistryPath(store: string): string {
  return derivedPath(providerLanesRoot(store), ["registry.json"]);
}

function parseSpec(value: unknown, store: string): LaneSpec {
  if (!isRecord(value) || !exactKeys(value, SPEC_KEYS)) invalid("lane spec");
  const laneId = safeLaneId(value.laneId, "laneId");
  const unitId = safeId(value.unitId, "unitId");
  const parent = choice(value.parent, PARENTS, "parent");
  const provider = choice(value.provider, PROVIDERS, "provider");
  const model = string(value.model, "model");
  const effort = choice(value.effort, EFFORTS, "effort");
  const mode = choice(value.mode, ACCESS_MODES, "mode");
  const promptPath = absolutePath(value.promptPath, "promptPath");
  const cwd = absolutePath(value.cwd, "cwd");
  const promptSha256 = digest(value.promptSha256, "promptSha256");
  const timeoutMs = timeout(value.timeoutMs);
  const retryIntervalMs = positiveMilliseconds(value.retryIntervalMs, "retryIntervalMs");
  if (retryIntervalMs < MINIMUM_RETRY_INTERVAL_MS) invalid("retryIntervalMs");
  const fingerprint = digest(value.laneFingerprint, "laneFingerprint");
  if (promptPath !== laneSnapshotPath(store, laneId)) invalid("promptPath");
  try {
    validateRunnerRoute({ parent, provider, model, effort, managed: true });
  } catch {
    invalid("route");
  }
  const spec = {
    laneId,
    unitId,
    parent,
    provider,
    model,
    effort,
    mode,
    promptPath,
    cwd,
    promptSha256,
    timeoutMs,
    retryIntervalMs,
    laneFingerprint: fingerprint,
  };
  if (laneFingerprint(spec, promptSha256) !== fingerprint) invalid("laneFingerprint");
  return spec;
}

function claimFields(
  value: JsonRecord,
  store: string,
  laneId: string,
  keys: readonly string[],
  claimedIds: Set<string>,
  artifactPaths: Set<string>,
  isNewClaim: boolean
): ClaimedFields {
  if (!exactKeys(value, keys)) invalid("attempt fields");
  const attemptId = safeId(value.attemptId, "attemptId");
  const claimedAt = instant(value.claimedAt, "claimedAt").value;
  const outputPath = absolutePath(value.outputPath, "outputPath");
  const receiptPath = absolutePath(value.receiptPath, "receiptPath");
  const expected = laneArtifactPaths(store, laneId, attemptId);
  if (outputPath !== expected.outputPath || receiptPath !== expected.receiptPath) {
    invalid("artifact path");
  }
  if (isNewClaim) {
    if (claimedIds.has(attemptId)) invalid("duplicate attemptId");
    if (artifactPaths.has(outputPath) || artifactPaths.has(receiptPath)) {
      invalid("duplicate artifact path");
    }
    claimedIds.add(attemptId);
    artifactPaths.add(outputPath);
    artifactPaths.add(receiptPath);
  }
  return { attemptId, claimedAt, outputPath, receiptPath };
}

function sameClaim(left: ClaimedFields, right: ClaimedFields): boolean {
  return left.attemptId === right.attemptId &&
    left.claimedAt === right.claimedAt &&
    left.outputPath === right.outputPath &&
    left.receiptPath === right.receiptPath;
}

function nextClaimAt(previous: LaneAttempt): number {
  switch (previous.kind) {
    case "registered":
      return Date.parse(previous.registeredAt);
    case "provider-paused":
      return Date.parse(previous.nextAttemptAt);
    case "failed":
      return Date.parse(previous.completedAt);
    case "interrupted":
      return Date.parse(previous.interruptedAt);
    case "claimed":
    case "complete":
      return Number.POSITIVE_INFINITY;
  }
}

function parseAttempts(
  value: unknown,
  store: string,
  spec: LaneSpec,
  claimedIds: Set<string>,
  artifactPaths: Set<string>
): readonly LaneAttempt[] {
  if (!Array.isArray(value) || value.length === 0) invalid("attempt history");
  const first = value[0];
  if (
    !isRecord(first) ||
    !exactKeys(first, ["kind", "registeredAt"]) ||
    first.kind !== "registered"
  ) {
    invalid("attempt history must start registered");
  }
  const attempts: LaneAttempt[] = [{
    kind: "registered",
    registeredAt: instant(first.registeredAt, "registeredAt").value,
  }];

  for (const raw of value.slice(1)) {
    if (!isRecord(raw) || typeof raw.kind !== "string") invalid("attempt row");
    const previous = attempts.at(-1);
    if (previous === undefined) invalid("attempt history");

    if (raw.kind === "claimed") {
      if (
        previous.kind !== "registered" &&
        previous.kind !== "provider-paused" &&
        previous.kind !== "failed" &&
        previous.kind !== "interrupted"
      ) {
        invalid("illegal claim transition");
      }
      const fields = claimFields(
        raw,
        store,
        spec.laneId,
        CLAIM_KEYS,
        claimedIds,
        artifactPaths,
        true
      );
      if (Date.parse(fields.claimedAt) < nextClaimAt(previous)) {
        invalid("claimedAt before prior transition");
      }
      attempts.push({ kind: "claimed", ...fields });
      continue;
    }

    if (previous.kind !== "claimed") invalid("terminal attempt without claim");
    const claimedAt = instant(previous.claimedAt, "claimedAt").milliseconds;

    if (raw.kind === "complete") {
      const fields = claimFields(
        raw,
        store,
        spec.laneId,
        [...CLAIM_KEYS, "completedAt", "receiptSha256", "outputSha256"],
        claimedIds,
        artifactPaths,
        false
      );
      if (!sameClaim(previous, fields)) invalid("complete claim identity");
      const completed = instant(raw.completedAt, "completedAt");
      if (completed.milliseconds < claimedAt) invalid("completedAt before claimedAt");
      attempts.push({
        kind: "complete",
        ...fields,
        completedAt: completed.value,
        receiptSha256: digest(raw.receiptSha256, "receiptSha256"),
        outputSha256: digest(raw.outputSha256, "outputSha256"),
      });
      continue;
    }

    if (raw.kind === "provider-paused") {
      const fields = claimFields(
        raw,
        store,
        spec.laneId,
        [
          ...CLAIM_KEYS,
          "observedAt",
          "nextAttemptAt",
          "receiptSha256",
          "resetEvidence",
        ],
        claimedIds,
        artifactPaths,
        false
      );
      if (!sameClaim(previous, fields)) invalid("pause claim identity");
      const observed = instant(raw.observedAt, "observedAt");
      const next = instant(raw.nextAttemptAt, "nextAttemptAt");
      if (
        spec.provider !== "claude" ||
        observed.milliseconds < claimedAt ||
        next.milliseconds - observed.milliseconds !== spec.retryIntervalMs
      ) {
        invalid("pause schedule");
      }
      const resetEvidence = string(raw.resetEvidence, "resetEvidence");
      if (resetEvidence.length > 1_000) invalid("resetEvidence");
      attempts.push({
        kind: "provider-paused",
        ...fields,
        observedAt: observed.value,
        nextAttemptAt: next.value,
        receiptSha256: digest(raw.receiptSha256, "receiptSha256"),
        resetEvidence,
      });
      continue;
    }

    if (raw.kind === "failed") {
      const fields = claimFields(
        raw,
        store,
        spec.laneId,
        [...CLAIM_KEYS, "completedAt", "receiptSha256"],
        claimedIds,
        artifactPaths,
        false
      );
      if (!sameClaim(previous, fields)) invalid("failure claim identity");
      const completed = instant(raw.completedAt, "completedAt");
      if (completed.milliseconds < claimedAt) invalid("completedAt before claimedAt");
      attempts.push({
        kind: "failed",
        ...fields,
        completedAt: completed.value,
        receiptSha256: digest(raw.receiptSha256, "receiptSha256"),
      });
      continue;
    }

    if (raw.kind === "interrupted") {
      const fields = claimFields(
        raw,
        store,
        spec.laneId,
        [...CLAIM_KEYS, "interruptedAt", "reason"],
        claimedIds,
        artifactPaths,
        false
      );
      if (!sameClaim(previous, fields)) invalid("interrupted claim identity");
      const interrupted = instant(raw.interruptedAt, "interruptedAt");
      if (interrupted.milliseconds < claimedAt) invalid("interruptedAt before claimedAt");
      const reason = string(raw.reason, "reason");
      if (reason.includes("\n") || reason.includes("\r")) invalid("reason");
      attempts.push({
        kind: "interrupted",
        ...fields,
        interruptedAt: interrupted.value,
        reason,
      });
      continue;
    }

    invalid("unknown attempt kind");
  }
  return attempts;
}

export function parseLaneRegistry(
  value: unknown,
  store: string,
  unitIds: ReadonlySet<string>,
  terminalUnitIds: ReadonlySet<string> = NO_TERMINAL_UNITS
): LaneRegistry {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "lanes"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.lanes)
  ) {
    invalid("registry root");
  }
  const laneIds = new Set<string>();
  const claimedIds = new Set<string>();
  const artifactPaths = new Set<string>();
  const activeProviders = new Set<Provider>();
  const lanes: Lane[] = [];

  for (const raw of value.lanes) {
    if (!isRecord(raw) || !exactKeys(raw, ["spec", "attempts"])) invalid("lane row");
    const spec = parseSpec(raw.spec, store);
    if (laneIds.has(spec.laneId)) invalid("duplicate laneId");
    if (!unitIds.has(spec.unitId)) invalid("unknown unitId");
    laneIds.add(spec.laneId);
    const attempts = parseAttempts(
      raw.attempts,
      store,
      spec,
      claimedIds,
      artifactPaths
    );
    const current = attempts.at(-1);
    if (current === undefined) invalid("attempt history");
    if (
      current.kind === "claimed" ||
      (current.kind === "provider-paused" && !terminalUnitIds.has(spec.unitId))
    ) {
      if (activeProviders.has(spec.provider)) invalid("multiple active lanes for provider");
      activeProviders.add(spec.provider);
    }
    lanes.push({ spec, attempts });
  }

  return { schemaVersion: 1, lanes };
}

export async function writePrivateAtomic(
  path: string,
  contents: string | Uint8Array
): Promise<void> {
  await writeFileAtomically(path, contents, 0o600);
}

export async function loadLaneRegistry(
  store: string,
  unitIds: ReadonlySet<string>,
  terminalUnitIds: ReadonlySet<string> = NO_TERMINAL_UNITS
): Promise<LaneRegistry> {
  const path = laneRegistryPath(store);
  if (!(await pathExists(path))) {
    throw new UserError(
      "provider lane registry is missing; the orchestrate store is corrupt"
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new UserError("provider lane registry is not valid JSON");
  }
  return parseLaneRegistry(value, store, unitIds, terminalUnitIds);
}

export async function saveLaneRegistry(
  store: string,
  registry: LaneRegistry,
  unitIds: ReadonlySet<string>,
  terminalUnitIds: ReadonlySet<string> = NO_TERMINAL_UNITS
): Promise<void> {
  const parsed = parseLaneRegistry(
    registry,
    store,
    unitIds,
    terminalUnitIds
  );
  await writePrivateAtomic(
    laneRegistryPath(store),
    `${JSON.stringify(parsed, null, 2)}\n`
  );
}

export async function initializeLaneRegistry(store: string): Promise<void> {
  const path = laneRegistryPath(store);
  if (await pathExists(path)) return;

  const root = providerLanesRoot(store);
  let entries: readonly string[] = [];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (entries.length > 0) {
    throw new UserError(
      "provider lane registry is missing with orphaned provider lane artifacts"
    );
  }
  await saveLaneRegistry(
    store,
    { schemaVersion: 1, lanes: [] },
    new Set()
  );
}

export function latestAttempt(lane: Lane): LaneAttempt {
  return lane.attempts.at(-1) ?? invalid(`lane ${lane.spec.laneId} has no attempts`);
}

export function appendAttempt(lane: Lane, attempt: LaneAttempt): Lane {
  return { ...lane, attempts: [...lane.attempts, attempt] };
}

export function replaceLane(registry: LaneRegistry, lane: Lane): LaneRegistry {
  return {
    ...registry,
    lanes: registry.lanes.map((old) =>
      old.spec.laneId === lane.spec.laneId ? lane : old
    ),
  };
}

export function hashBytes(contents: string | Uint8Array): string {
  return sha256Hex(contents);
}
