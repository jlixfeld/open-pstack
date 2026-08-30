import type { PreparedSetup, Snapshot } from "./engine.ts";
import { renderLane } from "../routing/role-map.ts";

export interface SetupFilesystem {
  read(path: string): Uint8Array | null;
  replaceAtomically(path: string, bytes: Uint8Array): void;
  remove(path: string): void;
}

export interface ProbeResult {
  readonly descriptor: string;
  readonly passed: boolean;
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function restore(snapshot: Snapshot, fs: SetupFilesystem): void {
  if (snapshot.bytes === null) fs.remove(snapshot.path);
  else fs.replaceAtomically(snapshot.path, snapshot.bytes);
}

export function commitSetup(prepared: PreparedSetup, probes: readonly ProbeResult[], fs: SetupFilesystem): void {
  const expected = prepared.probes.map(renderLane);
  if (
    probes.length !== expected.length ||
    probes.some((probe, index) => !probe.passed || probe.descriptor !== expected[index])
  ) {
    throw new Error("all final-map probes must pass before commit");
  }
  for (const target of prepared.targets) {
    if (!sameBytes(fs.read(target.path), target.bytes)) throw new Error(`stale setup baseline: ${target.path}`);
  }
  const changed = prepared.targets.filter((target) => !sameBytes(target.bytes, target.nextBytes));
  if (changed.length === 0) return;
  try {
    for (const target of changed) fs.replaceAtomically(target.path, target.nextBytes);
    for (const target of prepared.targets) {
      if (!sameBytes(fs.read(target.path), target.nextBytes)) throw new Error(`setup readback failed: ${target.path}`);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const target of prepared.targets) {
      try {
        restore(target, fs);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (rollbackFailures.length > 0) throw new Error(`${message}; rollback failed: ${rollbackFailures.join("; ")}`);
    throw error;
  }
}
