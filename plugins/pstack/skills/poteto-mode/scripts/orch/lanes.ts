import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import { laneFingerprint } from "../runner/identity.ts";
import { UserError } from "./store.ts";

export const DEFAULT_RETRY_INTERVAL_SECONDS = 1800;

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

export interface RegisteredAttempt { readonly kind: "registered"; readonly registeredAt: string; }
export interface ClaimedAttempt { readonly kind: "claimed"; readonly attemptId: string; readonly claimedAt: string; readonly outputPath: string; readonly receiptPath: string; }
type ClaimedFields = Omit<ClaimedAttempt, "kind">;
export interface CompleteAttempt extends ClaimedFields { readonly kind: "complete"; readonly completedAt: string; readonly receiptSha256: string; readonly outputSha256: string; }
export interface PausedAttempt extends ClaimedFields { readonly kind: "provider-paused"; readonly observedAt: string; readonly nextAttemptAt: string; readonly receiptSha256: string; readonly resetEvidence: string; }
export interface FailedAttempt extends ClaimedFields { readonly kind: "failed"; readonly completedAt: string; readonly receiptSha256: string; }
export interface InterruptedAttempt extends ClaimedFields { readonly kind: "interrupted"; readonly interruptedAt: string; readonly reason: string; }
export type LaneAttempt = RegisteredAttempt | ClaimedAttempt | CompleteAttempt | PausedAttempt | FailedAttempt | InterruptedAttempt;
export interface Lane { readonly spec: LaneSpec; readonly attempts: readonly LaneAttempt[]; }
interface Registry { readonly schemaVersion: 1; readonly lanes: readonly Lane[]; }
export interface RegisterParams { readonly laneId: string; readonly unitId: string; readonly parent: Parent; readonly provider: Provider; readonly model: string; readonly effort: Effort; readonly mode: AccessMode; readonly promptPath: string; readonly cwd: string; readonly intervalSeconds?: number; readonly timeoutSeconds?: number; }
export interface LaunchPlan { readonly laneId: string; readonly attemptId: string; readonly command: string; readonly argv: readonly string[]; readonly cwd: string; readonly outputPath: string; readonly receiptPath: string; }

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isOneOf<T extends string>(value: string, choices: readonly T[]): value is T { return choices.some((choice) => choice === value); }
function nonEmpty(value: string, label: string): string { if (value.trim().length === 0) throw new UserError(`${label} must not be empty`); return value; }
function isoNow(): string { return new Date().toISOString(); }
function parseInstant(value: string): number { const ms = Date.parse(value); if (!Number.isFinite(ms)) throw new UserError("provider lane registry contains an invalid timestamp"); return ms; }
function registryPath(store: string): string { return join(store, "provider-lanes", "registry.json"); }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; } }
async function atomicWrite(path: string, contents: string): Promise<void> { const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; try { await writeFile(temporary, contents, { flag: "wx" }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); } }
async function load(store: string): Promise<Registry> { const path = registryPath(store); if (!(await exists(path))) return { schemaVersion: 1, lanes: [] }; let raw: unknown; try { raw = JSON.parse(await readFile(path, "utf8")); } catch { throw new UserError("provider lane registry is not valid JSON"); } if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new UserError("provider lane registry has an invalid shape"); const record = raw as { readonly schemaVersion?: unknown; readonly lanes?: unknown }; if (record.schemaVersion !== 1 || !Array.isArray(record.lanes)) throw new UserError("provider lane registry has an invalid shape"); return raw as Registry; }
async function save(store: string, registry: Registry): Promise<void> { await mkdir(dirname(registryPath(store)), { recursive: true }); await atomicWrite(registryPath(store), `${JSON.stringify(registry, null, 2)}\n`); }
function latest(lane: Lane): LaneAttempt { const result = lane.attempts.at(-1); if (!result) throw new UserError(`lane ${lane.spec.laneId} has no attempts`); return result; }
function snapshotPath(store: string, laneId: string): string { return join(store, "provider-lanes", laneId, "prompt.md"); }
function artifactPaths(store: string, laneId: string, attemptId: string): { readonly outputPath: string; readonly receiptPath: string } { const root = join(store, "provider-lanes", laneId, "attempts"); return { outputPath: join(root, `${attemptId}.output.md`), receiptPath: join(root, `${attemptId}.receipt.json`) }; }
function append(lane: Lane, attempt: LaneAttempt): Lane { return { ...lane, attempts: [...lane.attempts, attempt] }; }
function replace(registry: Registry, lane: Lane): Registry { return { ...registry, lanes: registry.lanes.map((old) => old.spec.laneId === lane.spec.laneId ? lane : old) }; }
function attemptPlan(spec: LaneSpec, attempt: ClaimedAttempt): LaunchPlan { const runner = join(import.meta.dir, "..", "runner", "pstack-runner"); const argv = ["--parent", spec.parent, "--provider", spec.provider, "--model", spec.model, "--effort", spec.effort, "--mode", spec.mode, "--prompt", spec.promptPath, "--cwd", spec.cwd, "--output", attempt.outputPath, "--receipt", attempt.receiptPath, "--lane-id", spec.laneId, "--attempt-id", attempt.attemptId, "--lane-fingerprint", spec.laneFingerprint, "--prompt-sha256", spec.promptSha256] as const; const timeout = spec.timeoutMs === null ? [] : ["--timeout", String(spec.timeoutMs / 1000)] as const; return { laneId: spec.laneId, attemptId: attempt.attemptId, command: runner, argv: [...argv, ...timeout], cwd: spec.cwd, outputPath: attempt.outputPath, receiptPath: attempt.receiptPath }; }
async function claim(store: string, lane: Lane): Promise<{ readonly lane: Lane; readonly plan: LaunchPlan }> { const attemptId = randomUUID(); const paths = artifactPaths(store, lane.spec.laneId, attemptId); await mkdir(dirname(paths.outputPath), { recursive: true }); const attempt: ClaimedAttempt = { kind: "claimed", attemptId, claimedAt: isoNow(), ...paths }; const claimed = append(lane, attempt); return { lane: claimed, plan: attemptPlan(claimed.spec, attempt) }; }
function exactManagedReceipt(raw: unknown, spec: LaneSpec, attempt: ClaimedFields): { readonly kind: "complete"; readonly outputSha256: string; readonly receiptSha256: string } | { readonly kind: "provider-paused"; readonly receiptSha256: string; readonly resetEvidence: string } | { readonly kind: "failed"; readonly receiptSha256: string } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const receipt = raw as Record<string, unknown>;
  const managed = receipt.managedAttempt;
  if (receipt.schemaVersion !== 2 || managed === null || typeof managed !== "object" || Array.isArray(managed)) return null;
  const identity = managed as Record<string, unknown>;
  const exact = receipt.parent === spec.parent && receipt.provider === spec.provider && receipt.model === spec.model && receipt.effort === spec.effort && receipt.mode === spec.mode && receipt.cwd === spec.cwd && receipt.promptPath === spec.promptPath && receipt.outputPath === attempt.outputPath && receipt.receiptPath === attempt.receiptPath && receipt.timeoutMs === spec.timeoutMs && identity.verified === true && identity.laneId === spec.laneId && identity.attemptId === attempt.attemptId && identity.laneFingerprint === spec.laneFingerprint && identity.promptSha256 === spec.promptSha256;
  if (!exact) return null;
  const receiptSha256 = sha256(JSON.stringify(raw));
  if (receipt.status === "complete") {
    const proof = spec.provider === "codex" ? receipt.reportedModel === null && receipt.modelVerified === false && receipt.modelEvidence === "pinned-argv" : receipt.reportedModel === spec.model && receipt.modelVerified === true && receipt.modelEvidence === "provider-report";
    if (receipt.exitCode !== 0 || !proof) return null;
    return { kind: "complete", outputSha256: "", receiptSha256 };
  }
  if (receipt.status === "provider-paused" && spec.provider === "claude" && receipt.providerPause !== null && typeof receipt.providerPause === "object") return { kind: "provider-paused", receiptSha256, resetEvidence: JSON.stringify(receipt.providerPause).slice(0, 2000) };
  if (typeof receipt.status === "string" && receipt.status !== "complete" && receipt.status !== "provider-paused") return { kind: "failed", receiptSha256 };
  return null;
}
async function settle(store: string, lane: Lane): Promise<Lane> { const current = latest(lane); if (current.kind !== "claimed") return lane; if (!(await exists(current.receiptPath))) return lane; let raw: unknown; let receiptContents: string; try { receiptContents = await readFile(current.receiptPath, "utf8"); raw = JSON.parse(receiptContents); } catch { return lane; }
  const outcome = exactManagedReceipt(raw, lane.spec, current); if (outcome === null) return lane;
  if (outcome.kind === "complete") { let output: string; try { output = await readFile(current.outputPath, "utf8"); } catch { return lane; } if (output.length === 0) return lane; return append(lane, { ...current, kind: "complete", completedAt: isoNow(), receiptSha256: sha256(receiptContents), outputSha256: sha256(output) }); }
  if (outcome.kind === "provider-paused") { const observedAt = isoNow(); return append(lane, { ...current, kind: "provider-paused", observedAt, nextAttemptAt: new Date(Date.parse(observedAt) + lane.spec.retryIntervalMs).toISOString(), receiptSha256: sha256(receiptContents), resetEvidence: outcome.resetEvidence }); }
  return append(lane, { ...current, kind: "failed", completedAt: isoNow(), receiptSha256: sha256(receiptContents) }); }
async function settled(store: string, registry: Registry): Promise<Registry> { let result = registry; for (const lane of registry.lanes) result = replace(result, await settle(store, lane)); return result; }

export async function register(store: string, params: RegisterParams): Promise<Lane> { const laneId = nonEmpty(params.laneId, "lane id"); if (!isOneOf(params.parent, PARENTS) || !isOneOf(params.provider, PROVIDERS) || !isOneOf(params.effort, EFFORTS) || !isOneOf(params.mode, ACCESS_MODES)) throw new UserError("provider lane route is invalid"); const interval = params.intervalSeconds ?? DEFAULT_RETRY_INTERVAL_SECONDS; if (!Number.isSafeInteger(interval) || interval < 1) throw new UserError("interval seconds must be a positive integer"); const timeoutMs = params.timeoutSeconds === undefined ? null : params.timeoutSeconds * 1000; if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000)) throw new UserError("timeout seconds must be a positive integer"); const source = resolve(nonEmpty(params.promptPath, "prompt")); const cwd = resolve(nonEmpty(params.cwd, "cwd")); let prompt: string; try { prompt = await readFile(source, "utf8"); } catch { throw new UserError(`could not read prompt: ${source}`); } const target = snapshotPath(store, laneId); const promptSha256 = sha256(prompt); const spec: LaneSpec = { laneId, unitId: nonEmpty(params.unitId, "unit id"), parent: params.parent, provider: params.provider, model: nonEmpty(params.model, "model"), effort: params.effort, mode: params.mode, promptPath: target, cwd, promptSha256, timeoutMs, retryIntervalMs: interval * 1000, laneFingerprint: "" }; const immutable: LaneSpec = { ...spec, laneFingerprint: laneFingerprint(spec, promptSha256) }; const registry = await load(store); const present = registry.lanes.find((lane) => lane.spec.laneId === laneId); if (present !== undefined) { if (JSON.stringify(present.spec) !== JSON.stringify(immutable)) throw new UserError(`lane ${laneId} is already registered with a different immutable specification`); return present; } await mkdir(dirname(target), { recursive: true }); await atomicWrite(target, prompt); const lane: Lane = { spec: immutable, attempts: [{ kind: "registered", registeredAt: isoNow() }] }; await save(store, { ...registry, lanes: [...registry.lanes, lane] }); return lane; }
export async function tick(store: string): Promise<readonly LaunchPlan[]> { let registry = await settled(store, await load(store)); const plans: LaunchPlan[] = []; const providers = new Set<Provider>(); for (const lane of registry.lanes) { if (providers.has(lane.spec.provider)) continue; const current = latest(lane); if (current.kind === "complete" || current.kind === "failed" || current.kind === "interrupted") continue; if (current.kind === "provider-paused") { providers.add(lane.spec.provider); if (Date.now() < parseInstant(current.nextAttemptAt)) continue; const claimed = await claim(store, lane); registry = replace(registry, claimed.lane); plans.push(claimed.plan); continue; }
    if (current.kind === "claimed") { providers.add(lane.spec.provider); if (!(await exists(current.outputPath)) && !(await exists(current.receiptPath))) plans.push(attemptPlan(lane.spec, current)); continue; }
    const paused = registry.lanes.find((other) => other.spec.provider === lane.spec.provider && latest(other).kind === "provider-paused"); if (paused !== undefined) { providers.add(lane.spec.provider); continue; } providers.add(lane.spec.provider); const claimed = await claim(store, lane); registry = replace(registry, claimed.lane); plans.push(claimed.plan); }
  await save(store, registry); return plans; }
export async function retry(store: string, laneId: string): Promise<LaunchPlan> { let registry = await settled(store, await load(store)); const lane = registry.lanes.find((row) => row.spec.laneId === laneId); if (lane === undefined) throw new UserError(`lane ${laneId} not found`); const current = latest(lane); if (current.kind !== "failed" && current.kind !== "interrupted") throw new UserError(`lane ${laneId} is not eligible for explicit retry`); const claimed = await claim(store, lane); registry = replace(registry, claimed.lane); await save(store, registry); return claimed.plan; }
export async function release(store: string, laneId: string, attemptId: string, reason: string): Promise<Lane> { let registry = await load(store); const lane = registry.lanes.find((row) => row.spec.laneId === laneId); if (lane === undefined) throw new UserError(`lane ${laneId} not found`); const current = latest(lane); if (current.kind !== "claimed" || current.attemptId !== attemptId) throw new UserError(`lane ${laneId} does not have claimed attempt ${attemptId}`); const released = append(lane, { ...current, kind: "interrupted", interruptedAt: isoNow(), reason: nonEmpty(reason, "release reason") }); registry = replace(registry, released); await save(store, registry); return released; }
export async function checkUnit(store: string, unitId: string): Promise<boolean> { const registry = await settled(store, await load(store)); await save(store, registry); const attached = registry.lanes.filter((lane) => lane.spec.unitId === unitId); for (const lane of attached) { const current = latest(lane); if (current.kind !== "complete") return false; let prompt: string; let receipt: string; let output: string; try { [prompt, receipt, output] = await Promise.all([readFile(lane.spec.promptPath, "utf8"), readFile(current.receiptPath, "utf8"), readFile(current.outputPath, "utf8")]); } catch { return false; } if (prompt.length === 0 || output.length === 0 || sha256(prompt) !== lane.spec.promptSha256 || sha256(output) !== current.outputSha256 || sha256(receipt) !== current.receiptSha256) return false; let parsed: unknown; try { parsed = JSON.parse(receipt); } catch { return false; } const valid = exactManagedReceipt(parsed, lane.spec, current); if (valid === null || valid.kind !== "complete") return false; }
  return true; }
