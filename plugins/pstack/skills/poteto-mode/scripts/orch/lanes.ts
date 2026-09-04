import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { laneFingerprint } from "../runner/identity.ts";
import { parseRunnerReceipt } from "../runner/receipt.ts";
import {
  ACCESS_MODES,
  EFFORTS,
  PARENTS,
  PROVIDERS,
  type AccessMode,
  type Effort,
  type Parent,
  type Provider,
  type RunnerReceiptV2,
} from "../runner/types.ts";
import {
  SAFE_ID_PATTERN,
  SAFE_LANE_ID_PATTERN,
  validateExistingDirectory,
  validateRunnerRoute,
} from "../runner/validation.ts";
import { UserError } from "./errors.ts";
import {
  appendAttempt,
  hashBytes,
  laneArtifactPaths,
  laneSnapshotPath,
  latestAttempt,
  loadLaneRegistry,
  MINIMUM_RETRY_INTERVAL_MS,
  pathExists,
  replaceLane,
  saveLaneRegistry,
  writePrivateAtomic,
  type ClaimedAttempt,
  type Lane,
  type LaneRegistry,
  type LaneSpec,
  type PausedAttempt,
} from "./lane-registry.ts";

export type {
  ClaimedAttempt,
  CompleteAttempt,
  FailedAttempt,
  InterruptedAttempt,
  Lane,
  LaneAttempt,
  LaneSpec,
  PausedAttempt,
  RegisteredAttempt,
} from "./lane-registry.ts";

export const DEFAULT_RETRY_INTERVAL_SECONDS = MINIMUM_RETRY_INTERVAL_MS / 1_000;

export interface RegisterParams {
  readonly laneId: string;
  readonly unitId: string;
  readonly parent: Parent;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: AccessMode;
  readonly promptPath: string;
  readonly cwd: string;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
}

export interface LaunchPlan {
  readonly laneId: string;
  readonly attemptId: string;
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly outputPath: string;
  readonly receiptPath: string;
}

export interface LaneCheck {
  readonly unitId: string;
  readonly ready: boolean;
  readonly blockingLaneIds: readonly string[];
}

export type LaneClock = () => number;

const systemClock: LaneClock = () => Date.now();
const NO_TERMINAL_UNITS: ReadonlySet<string> = new Set();

function nowIso(clock: LaneClock): string {
  return new Date(clock()).toISOString();
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new UserError(`${label} must match ${SAFE_ID_PATTERN.source}`);
  }
  return value;
}

function safeLaneId(value: string): string {
  if (!SAFE_LANE_ID_PATTERN.test(value)) {
    throw new UserError(
      `lane id must match ${SAFE_LANE_ID_PATTERN.source} and must be lowercase`
    );
  }
  return value;
}

function choice<T extends string>(
  value: string,
  choices: readonly T[],
  label: string
): T {
  const result = choices.find((candidate) => candidate === value);
  if (result === undefined) {
    throw new UserError(`${label} must be one of: ${choices.join(", ")}`);
  }
  return result;
}

function retryIntervalSeconds(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < DEFAULT_RETRY_INTERVAL_SECONDS ||
    !Number.isSafeInteger(value * 1_000)
  ) {
    throw new UserError(
      `interval seconds must be an integer of at least ${DEFAULT_RETRY_INTERVAL_SECONDS}`
    );
  }
  return value;
}

function positiveSeconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value * 1_000)) {
    throw new UserError(`${label} must be a positive integer`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new UserError(`${label} must not be empty`);
  return value;
}

function validateRoute(params: RegisterParams, cwd: string): void {
  const parent = choice(params.parent, PARENTS, "parent");
  const provider = choice(params.provider, PROVIDERS, "provider");
  const effort = choice(params.effort, EFFORTS, "effort");
  choice(params.mode, ACCESS_MODES, "mode");
  try {
    validateRunnerRoute({
      parent,
      provider,
      model: params.model,
      effort,
      managed: true,
    });
    validateExistingDirectory(cwd);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

async function readPrompt(path: string): Promise<Uint8Array> {
  try {
    const details = await stat(path);
    if (!details.isFile()) throw new Error("not a file");
    return await readFile(path);
  } catch {
    throw new UserError(`could not read prompt: ${path}`);
  }
}

async function validateLaunchInputs(spec: LaneSpec): Promise<void> {
  let prompt: Uint8Array;
  try {
    const details = await stat(spec.promptPath);
    if (!details.isFile()) throw new Error("not a file");
    prompt = await readFile(spec.promptPath);
  } catch {
    throw new UserError(
      `lane ${spec.laneId} immutable prompt snapshot is missing or unreadable`
    );
  }
  if (prompt.byteLength === 0) {
    throw new UserError(
      `lane ${spec.laneId} immutable prompt snapshot is empty`
    );
  }
  if (hashBytes(prompt) !== spec.promptSha256) {
    throw new UserError(
      `lane ${spec.laneId} immutable prompt snapshot has changed`
    );
  }
  try {
    if (!(await stat(spec.cwd)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new UserError(
      `lane ${spec.laneId} working directory is missing or is not a directory`
    );
  }
}

function monotonicTransitionTime(lane: Lane, clock: LaneClock): string {
  const current = latestAttempt(lane);
  let floor: number;
  switch (current.kind) {
    case "registered":
      floor = Date.parse(current.registeredAt);
      break;
    case "claimed":
      floor = Date.parse(current.claimedAt);
      break;
    case "complete":
    case "failed":
      floor = Date.parse(current.completedAt);
      break;
    case "provider-paused":
      floor = Date.parse(current.nextAttemptAt);
      break;
    case "interrupted":
      floor = Date.parse(current.interruptedAt);
      break;
  }
  return new Date(Math.max(clock(), floor)).toISOString();
}

function attemptPlan(spec: LaneSpec, attempt: ClaimedAttempt): LaunchPlan {
  const command = resolve(import.meta.dir, "..", "runner", "pstack-runner");
  const argv = [
    "--parent",
    spec.parent,
    "--provider",
    spec.provider,
    "--model",
    spec.model,
    "--effort",
    spec.effort,
    "--mode",
    spec.mode,
    "--prompt",
    spec.promptPath,
    "--cwd",
    spec.cwd,
    "--output",
    attempt.outputPath,
    "--receipt",
    attempt.receiptPath,
    "--lane-id",
    spec.laneId,
    "--attempt-id",
    attempt.attemptId,
    "--lane-fingerprint",
    spec.laneFingerprint,
    "--prompt-sha256",
    spec.promptSha256,
  ];
  if (spec.timeoutMs !== null) {
    argv.push("--timeout", String(spec.timeoutMs / 1_000));
  }
  return {
    laneId: spec.laneId,
    attemptId: attempt.attemptId,
    command,
    argv,
    cwd: spec.cwd,
    outputPath: attempt.outputPath,
    receiptPath: attempt.receiptPath,
  };
}

async function claimLane(
  store: string,
  lane: Lane,
  clock: LaneClock
): Promise<{ readonly lane: Lane; readonly plan: LaunchPlan }> {
  await validateLaunchInputs(lane.spec);
  const attemptId = randomUUID();
  const paths = laneArtifactPaths(store, lane.spec.laneId, attemptId);
  await mkdir(dirname(paths.outputPath), { recursive: true });
  const attempt: ClaimedAttempt = {
    kind: "claimed",
    attemptId,
    claimedAt: monotonicTransitionTime(lane, clock),
    ...paths,
  };
  const claimed = appendAttempt(lane, attempt);
  return { lane: claimed, plan: attemptPlan(claimed.spec, attempt) };
}

function receiptMatchesClaim(
  receipt: RunnerReceiptV2,
  spec: LaneSpec,
  attempt: Omit<ClaimedAttempt, "kind">
): boolean {
  const managed = receipt.managedAttempt;
  return receipt.parent === spec.parent &&
    receipt.provider === spec.provider &&
    receipt.model === spec.model &&
    receipt.effort === spec.effort &&
    receipt.mode === spec.mode &&
    receipt.cwd === spec.cwd &&
    receipt.promptPath === spec.promptPath &&
    receipt.outputPath === attempt.outputPath &&
    receipt.receiptPath === attempt.receiptPath &&
    receipt.timeoutMs === spec.timeoutMs &&
    Date.parse(receipt.startedAt) >= Date.parse(attempt.claimedAt) &&
    managed !== null &&
    managed.verified === true &&
    managed.laneId === spec.laneId &&
    managed.attemptId === attempt.attemptId &&
    managed.laneFingerprint === spec.laneFingerprint &&
    managed.promptSha256 === spec.promptSha256;
}

async function parseReceipt(path: string): Promise<{
  readonly contents: Uint8Array;
  readonly receipt: RunnerReceiptV2;
} | null> {
  let contents: Uint8Array;
  let raw: unknown;
  try {
    contents = await readFile(path);
    raw = JSON.parse(new TextDecoder().decode(contents));
  } catch {
    return null;
  }
  const receipt = parseRunnerReceipt(raw);
  return receipt === null ? null : { contents, receipt };
}

async function settleLane(store: string, lane: Lane): Promise<Lane> {
  const current = latestAttempt(lane);
  if (current.kind !== "claimed" || !(await pathExists(current.receiptPath))) {
    return lane;
  }
  const parsed = await parseReceipt(current.receiptPath);
  if (parsed === null || !receiptMatchesClaim(parsed.receipt, lane.spec, current)) {
    return lane;
  }

  const receiptSha256 = hashBytes(parsed.contents);
  if (parsed.receipt.status === "complete") {
    let output: Uint8Array;
    try {
      output = await readFile(current.outputPath);
    } catch {
      return lane;
    }
    if (output.byteLength === 0) return lane;
    return appendAttempt(lane, {
      ...current,
      kind: "complete",
      completedAt: parsed.receipt.completedAt,
      receiptSha256,
      outputSha256: hashBytes(output),
    });
  }

  if (await pathExists(current.outputPath)) return lane;

  if (parsed.receipt.status === "provider-paused") {
    const observedAt = parsed.receipt.providerPause.observedAt;
    const observedMilliseconds = Date.parse(observedAt);
    return appendAttempt(lane, {
      ...current,
      kind: "provider-paused",
      observedAt,
      nextAttemptAt: new Date(
        observedMilliseconds + lane.spec.retryIntervalMs
      ).toISOString(),
      receiptSha256,
      resetEvidence: parsed.receipt.providerPause.resetEvidence,
    });
  }

  return appendAttempt(lane, {
    ...current,
    kind: "failed",
    completedAt: parsed.receipt.completedAt,
    receiptSha256,
  });
}

async function settleRegistry(
  store: string,
  registry: LaneRegistry
): Promise<LaneRegistry> {
  let result = registry;
  for (const lane of registry.lanes) {
    result = replaceLane(result, await settleLane(store, lane));
  }
  return result;
}

interface ProviderOccupancy {
  readonly lane: Lane;
  readonly attempt: ClaimedAttempt | PausedAttempt;
}

function providerBarrier(
  registry: LaneRegistry,
  provider: Provider,
  terminalUnitIds: ReadonlySet<string>
): ProviderOccupancy | null {
  for (const lane of registry.lanes) {
    if (lane.spec.provider !== provider) continue;
    const current = latestAttempt(lane);
    if (
      current.kind === "claimed" ||
      (current.kind === "provider-paused" &&
        !terminalUnitIds.has(lane.spec.unitId))
    ) {
      return { lane, attempt: current };
    }
  }
  return null;
}

async function verifiedComplete(lane: Lane): Promise<boolean> {
  const current = latestAttempt(lane);
  if (current.kind !== "complete") return false;
  let prompt: Uint8Array;
  let receiptContents: Uint8Array;
  let output: Uint8Array;
  try {
    [prompt, receiptContents, output] = await Promise.all([
      readFile(lane.spec.promptPath),
      readFile(current.receiptPath),
      readFile(current.outputPath),
    ]);
  } catch {
    return false;
  }
  if (
    prompt.byteLength === 0 ||
    output.byteLength === 0 ||
    hashBytes(prompt) !== lane.spec.promptSha256 ||
    hashBytes(receiptContents) !== current.receiptSha256 ||
    hashBytes(output) !== current.outputSha256
  ) {
    return false;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(receiptContents));
  } catch {
    return false;
  }
  const parsed = parseRunnerReceipt(raw);
  return parsed !== null &&
    parsed.status === "complete" &&
    receiptMatchesClaim(parsed, lane.spec, current);
}

export async function register(
  store: string,
  params: RegisterParams,
  unitIds: ReadonlySet<string>,
  terminalUnitIds: ReadonlySet<string> = NO_TERMINAL_UNITS,
  clock: LaneClock = systemClock
): Promise<Lane> {
  const laneId = safeLaneId(params.laneId);
  const unitId = safeId(params.unitId, "unit id");
  const source = resolve(nonEmpty(params.promptPath, "prompt"));
  const cwd = resolve(nonEmpty(params.cwd, "cwd"));
  validateRoute(params, cwd);
  const intervalSeconds = retryIntervalSeconds(
    params.intervalSeconds ?? DEFAULT_RETRY_INTERVAL_SECONDS
  );
  const timeoutSeconds = params.timeoutSeconds === undefined
    ? null
    : positiveSeconds(params.timeoutSeconds, "timeout seconds");
  const prompt = await readPrompt(source);
  if (prompt.byteLength === 0) {
    throw new UserError("prompt must not be empty");
  }
  const promptPath = laneSnapshotPath(store, laneId);
  const promptSha256 = hashBytes(prompt);
  const partial = {
    laneId,
    unitId,
    parent: params.parent,
    provider: params.provider,
    model: nonEmpty(params.model, "model"),
    effort: params.effort,
    mode: params.mode,
    promptPath,
    cwd,
    promptSha256,
    timeoutMs: timeoutSeconds === null ? null : timeoutSeconds * 1_000,
    retryIntervalMs: intervalSeconds * 1_000,
  };
  const spec: LaneSpec = {
    ...partial,
    laneFingerprint: laneFingerprint(partial, promptSha256),
  };

  const registry = await loadLaneRegistry(store, unitIds, terminalUnitIds);
  const present = registry.lanes.find((lane) => lane.spec.laneId === laneId);
  if (present !== undefined) {
    if (JSON.stringify(present.spec) !== JSON.stringify(spec)) {
      throw new UserError(
        `lane ${laneId} is already registered with a different immutable specification`
      );
    }
    return present;
  }

  await writePrivateAtomic(promptPath, prompt);
  const lane: Lane = {
    spec,
    attempts: [{ kind: "registered", registeredAt: nowIso(clock) }],
  };
  await saveLaneRegistry(
    store,
    {
      ...registry,
      lanes: [...registry.lanes, lane],
    },
    unitIds,
    terminalUnitIds
  );
  return lane;
}

export async function tick(
  store: string,
  unitIds: ReadonlySet<string>,
  terminalUnitIds: ReadonlySet<string> = NO_TERMINAL_UNITS,
  clock: LaneClock = systemClock
): Promise<readonly LaunchPlan[]> {
  let registry = await settleRegistry(
    store,
    await loadLaneRegistry(store, unitIds, terminalUnitIds)
  );
  const plans: LaunchPlan[] = [];
  const providers = registry.lanes.reduce<Provider[]>((result, lane) => {
    if (!result.includes(lane.spec.provider)) result.push(lane.spec.provider);
    return result;
  }, []);

  for (const provider of providers) {
    const barrier = providerBarrier(registry, provider, terminalUnitIds);
    if (barrier !== null) {
      const current = barrier.attempt;
      if (current.kind === "claimed") {
        if (terminalUnitIds.has(barrier.lane.spec.unitId)) continue;
        if (
          !(await pathExists(current.outputPath)) &&
          !(await pathExists(current.receiptPath))
        ) {
          await validateLaunchInputs(barrier.lane.spec);
          plans.push(attemptPlan(barrier.lane.spec, current));
        }
        continue;
      }
      if (clock() < Date.parse(current.nextAttemptAt)) continue;
      const claimed = await claimLane(store, barrier.lane, clock);
      registry = replaceLane(registry, claimed.lane);
      plans.push(claimed.plan);
      continue;
    }

    const eligible = registry.lanes.find(
      (lane) =>
        lane.spec.provider === provider &&
        !terminalUnitIds.has(lane.spec.unitId) &&
        latestAttempt(lane).kind === "registered"
    );
    if (eligible === undefined) continue;
    const claimed = await claimLane(store, eligible, clock);
    registry = replaceLane(registry, claimed.lane);
    plans.push(claimed.plan);
  }

  await saveLaneRegistry(store, registry, unitIds, terminalUnitIds);
  return plans;
}

export async function retry(
  store: string,
  laneId: string,
  unitIds: ReadonlySet<string>,
  terminalUnitIds: ReadonlySet<string> = NO_TERMINAL_UNITS,
  clock: LaneClock = systemClock
): Promise<LaunchPlan> {
  const cleanLaneId = safeLaneId(laneId);
  let registry = await settleRegistry(
    store,
    await loadLaneRegistry(store, unitIds, terminalUnitIds)
  );
  const lane = registry.lanes.find((row) => row.spec.laneId === cleanLaneId);
  if (lane === undefined) throw new UserError(`lane ${cleanLaneId} not found`);
  const current = latestAttempt(lane);
  if (current.kind !== "failed" && current.kind !== "interrupted") {
    await saveLaneRegistry(store, registry, unitIds, terminalUnitIds);
    throw new UserError(`lane ${cleanLaneId} is not eligible for explicit retry`);
  }
  const barrier = providerBarrier(registry, lane.spec.provider, terminalUnitIds);
  if (barrier !== null) {
    await saveLaneRegistry(store, registry, unitIds, terminalUnitIds);
    throw new UserError(
      `provider ${lane.spec.provider} is occupied by lane ${barrier.lane.spec.laneId}`
    );
  }
  const claimed = await claimLane(store, lane, clock);
  registry = replaceLane(registry, claimed.lane);
  await saveLaneRegistry(store, registry, unitIds, terminalUnitIds);
  return claimed.plan;
}

export async function release(
  store: string,
  laneId: string,
  attemptId: string,
  reason: string,
  unitIds: ReadonlySet<string>,
  terminalUnitIds: ReadonlySet<string> = NO_TERMINAL_UNITS,
  clock: LaneClock = systemClock
): Promise<Lane> {
  const cleanLaneId = safeLaneId(laneId);
  let registry = await settleRegistry(
    store,
    await loadLaneRegistry(store, unitIds, terminalUnitIds)
  );
  await saveLaneRegistry(store, registry, unitIds, terminalUnitIds);
  const lane = registry.lanes.find((row) => row.spec.laneId === cleanLaneId);
  if (lane === undefined) throw new UserError(`lane ${cleanLaneId} not found`);
  const current = latestAttempt(lane);
  if (current.kind !== "claimed" || current.attemptId !== attemptId) {
    throw new UserError(
      `lane ${cleanLaneId} does not have claimed attempt ${attemptId}`
    );
  }
  const released = appendAttempt(lane, {
    ...current,
    kind: "interrupted",
    interruptedAt: monotonicTransitionTime(lane, clock),
    reason: nonEmpty(reason, "release reason"),
  });
  registry = replaceLane(registry, released);
  await saveLaneRegistry(store, registry, unitIds, terminalUnitIds);
  return released;
}

export async function checkUnit(
  store: string,
  unitId: string,
  unitIds: ReadonlySet<string>,
  terminalUnitIds: ReadonlySet<string> = NO_TERMINAL_UNITS
): Promise<LaneCheck> {
  const registry = await settleRegistry(
    store,
    await loadLaneRegistry(store, unitIds, terminalUnitIds)
  );
  await saveLaneRegistry(store, registry, unitIds, terminalUnitIds);
  const attached = registry.lanes.filter((lane) => lane.spec.unitId === unitId);
  const blockingLaneIds: string[] = [];
  for (const lane of attached) {
    if (!(await verifiedComplete(lane))) blockingLaneIds.push(lane.spec.laneId);
  }
  return {
    unitId,
    ready: blockingLaneIds.length === 0,
    blockingLaneIds,
  };
}
