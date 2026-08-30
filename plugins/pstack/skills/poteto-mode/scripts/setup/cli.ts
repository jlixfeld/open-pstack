import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { prepareSetup, type Snapshot } from "./engine.ts";
import { nodeFilesystem } from "./integration.ts";
import { commitSetup, type ProbeResult } from "./transaction.ts";
import { parseLane, type RoleAssignment } from "../routing/role-map.ts";
import { parseManifest } from "../routing/manifest.ts";

interface PlanTarget {
  readonly path: string;
  readonly hash: string | null;
}

interface SetupPlan {
  readonly schemaVersion: 1;
  readonly parent: "claude" | "codex";
  readonly manifest: { readonly path: string; readonly hash: string };
  readonly targets: readonly [PlanTarget, PlanTarget];
  readonly edits: readonly { readonly role: string; readonly lanes: readonly string[] }[];
  readonly probes: readonly string[];
}

interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const defaultIo: Io = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function read(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function required(options: ReadonlyMap<string, string[]>, name: string): string {
  const values = options.get(name) ?? [];
  if (values.length !== 1 || values[0].trim().length === 0) throw new Error(`--${name} is required exactly once`);
  return values[0];
}

function one(options: ReadonlyMap<string, string[]>, name: string): string | null {
  const values = options.get(name) ?? [];
  if (values.length > 1) throw new Error(`--${name} may appear once`);
  return values[0] ?? null;
}

function options(argv: readonly string[]): ReadonlyMap<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined) throw new Error(`expected --flag value near ${flag}`);
    const name = flag.slice(2);
    const current = parsed.get(name) ?? [];
    parsed.set(name, [...current, value]);
  }
  return parsed;
}

function known(options: ReadonlyMap<string, string[]>, allowed: readonly string[]): void {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) throw new Error(`unknown option: --${name}`);
  }
}

function parent(value: string): "claude" | "codex" {
  if (value === "claude" || value === "codex") return value;
  throw new Error("--parent must be claude or codex");
}

function snapshot(path: string): Snapshot {
  return { path, bytes: read(path) };
}

function descriptor(lane: { readonly provider: string; readonly model: string; readonly effort: string }): string {
  return `${lane.provider}:${lane.model}@${lane.effort}`;
}

function parseEdits(values: readonly string[], manifestMarkdown: string): readonly RoleAssignment[] {
  const manifest = parseManifest(manifestMarkdown);
  return values.map((value) => {
    const delimiter = value.indexOf("=");
    if (delimiter <= 0) throw new Error(`edit must be role=lane[,lane]: ${value}`);
    const role = value.slice(0, delimiter).trim();
    const lanes = value.slice(delimiter + 1).split(",").map((lane) => parseLane(lane, manifest));
    return { role, lanes };
  });
}

function encodePlan(plan: SetupPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${label}`);
  return value;
}

function target(value: unknown): PlanTarget {
  if (!isRecord(value)) throw new Error("invalid plan target");
  const hashValue = value.hash;
  if (hashValue !== null && typeof hashValue !== "string") throw new Error("invalid plan target hash");
  return { path: string(value.path, "plan target path"), hash: hashValue };
}

function targets(value: unknown): readonly [PlanTarget, PlanTarget] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("setup plan needs exactly two targets");
  return [target(value[0]), target(value[1])];
}

function planFromUnknown(value: unknown): SetupPlan {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("invalid setup plan");
  const parentValue = parent(string(value.parent, "plan parent"));
  if (!isRecord(value.manifest)) throw new Error("invalid plan manifest");
  if (!Array.isArray(value.edits) || !Array.isArray(value.probes)) throw new Error("invalid setup plan collections");
  const parsedTargets = targets(value.targets);
  const edits = value.edits.map((edit) => {
    if (!isRecord(edit) || !Array.isArray(edit.lanes)) throw new Error("invalid plan edit");
    return { role: string(edit.role, "plan edit role"), lanes: edit.lanes.map((lane) => string(lane, "plan edit lane")) };
  });
  return {
    schemaVersion: 1,
    parent: parentValue,
    manifest: { path: string(value.manifest.path, "plan manifest path"), hash: string(value.manifest.hash, "plan manifest hash") },
    targets: parsedTargets,
    edits,
    probes: value.probes.map((probe) => string(probe, "plan probe")),
  };
}

function loadPlan(path: string): SetupPlan {
  return planFromUnknown(JSON.parse(readFileSync(path, "utf8")));
}

function loadProbeResults(path: string): readonly ProbeResult[] {
  const source: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(source)) throw new Error("probe results must be a JSON array");
  return source.map((result) => {
    if (!isRecord(result) || typeof result.passed !== "boolean") throw new Error("invalid probe result");
    return { descriptor: string(result.descriptor, "probe descriptor"), passed: result.passed };
  });
}

function targetHash(path: string): string | null {
  const bytes = read(path);
  return bytes === null ? null : hash(bytes);
}

function verifyBaselines(plan: SetupPlan, manifestMarkdown: Uint8Array): void {
  if (hash(manifestMarkdown) !== plan.manifest.hash) throw new Error("stale setup plan: manifest changed");
  for (const item of plan.targets) {
    if (targetHash(item.path) !== item.hash) throw new Error(`stale setup plan: target changed: ${item.path}`);
  }
}

function prepareFromPlan(plan: SetupPlan, manifestMarkdown: string) {
  const edits = parseEdits(plan.edits.map((edit) => `${edit.role}=${edit.lanes.join(",")}`), manifestMarkdown);
  const prepared = prepareSetup({
    parent: plan.parent,
    manifestMarkdown,
    sheet: snapshot(plan.targets[0].path),
    integration: snapshot(plan.targets[1].path),
    edits,
  });
  const probes = prepared.probes.map(descriptor);
  if (probes.join("\n") !== plan.probes.join("\n")) throw new Error("stale setup plan: rendered probe plan changed");
  return prepared;
}

export function prepare(argv: readonly string[], io: Io = defaultIo): void {
  const parsed = options(argv);
  known(parsed, ["parent", "manifest", "sheet", "integration", "plan", "edit"]);
  const parentValue = parent(required(parsed, "parent"));
  const manifestPath = required(parsed, "manifest");
  const sheetPath = required(parsed, "sheet");
  const integrationPath = required(parsed, "integration");
  const planPath = required(parsed, "plan");
  const manifestBytes = readFileSync(manifestPath);
  const manifestMarkdown = new TextDecoder().decode(manifestBytes);
  const edits = parseEdits(parsed.get("edit") ?? [], manifestMarkdown);
  const prepared = prepareSetup({ parent: parentValue, manifestMarkdown, sheet: snapshot(sheetPath), integration: snapshot(integrationPath), edits });
  const plan: SetupPlan = {
    schemaVersion: 1,
    parent: parentValue,
    manifest: { path: manifestPath, hash: hash(manifestBytes) },
    targets: [
      { path: sheetPath, hash: targetHash(sheetPath) },
      { path: integrationPath, hash: targetHash(integrationPath) },
    ],
    edits: edits.map((edit) => ({ role: edit.role, lanes: edit.lanes.map((lane) => typeof lane === "string" ? lane : descriptor(lane)) })),
    probes: prepared.probes.map(descriptor),
  };
  writeFileSync(planPath, encodePlan(plan), { encoding: "utf8", mode: 0o600, flag: "wx" });
  io.stdout(`${prepared.preview.join("\n")}\nprobes: ${plan.probes.join(", ")}\nplan: ${basename(planPath)}\n`);
}

export function commit(argv: readonly string[]): void {
  const parsed = options(argv);
  known(parsed, ["plan", "probe-results"]);
  const planPath = required(parsed, "plan");
  const receiptsPath = required(parsed, "probe-results");
  if (one(parsed, "parent") !== null || one(parsed, "manifest") !== null || one(parsed, "sheet") !== null || one(parsed, "integration") !== null || (parsed.get("edit") ?? []).length > 0) {
    throw new Error("commit accepts only --plan and --probe-results");
  }
  const plan = loadPlan(planPath);
  const manifestBytes = readFileSync(plan.manifest.path);
  verifyBaselines(plan, manifestBytes);
  const prepared = prepareFromPlan(plan, new TextDecoder().decode(manifestBytes));
  commitSetup(prepared, loadProbeResults(receiptsPath), nodeFilesystem());
}

export function main(argv: readonly string[], io: Io = defaultIo): number {
  try {
    const [command, ...rest] = argv;
    if (command === "prepare") prepare(rest, io);
    else if (command === "commit") commit(rest);
    else throw new Error("usage: pstack-setup <prepare|commit> ...");
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 64;
  }
}
