import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SetupFilesystem } from "./transaction.ts";

export interface AtomicFileOperations {
  readonly exists: (path: string) => boolean;
  readonly isSymlink: (path: string) => boolean;
  readonly makeParent: (path: string) => void;
  readonly mode: (path: string) => number;
  readonly write: (path: string, bytes: Uint8Array, mode: number) => void;
  readonly rename: (source: string, target: string) => void;
  readonly remove: (path: string) => void;
}

const nodeAtomicOperations: AtomicFileOperations = {
  exists: existsSync,
  isSymlink: (path) => lstatSync(path).isSymbolicLink(),
  makeParent: (path) => mkdirSync(dirname(path), { recursive: true }),
  mode: (path) => statSync(path).mode & 0o777,
  write: (path, bytes, mode) => writeFileSync(path, bytes, { mode }),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
};

export function replaceFileAtomically(
  path: string,
  bytes: Uint8Array,
  operations: AtomicFileOperations = nodeAtomicOperations,
  nonce: string = `${Date.now()}-${Math.random().toString(16).slice(2)}`
): void {
  const exists = operations.exists(path);
  if (exists && operations.isSymlink(path)) throw new Error(`setup target must not be a symlink: ${path}`);
  operations.makeParent(path);
  const mode = exists ? operations.mode(path) : 0o600;
  const temporary = join(dirname(path), `.${nonce}.pstack`);
  try {
    operations.write(temporary, bytes, mode);
    operations.rename(temporary, path);
  } catch (error) {
    operations.remove(temporary);
    throw error;
  }
}

export function nodeFilesystem(): SetupFilesystem {
  return {
    read(path) {
      if (!existsSync(path)) return null;
      if (lstatSync(path).isSymbolicLink()) throw new Error(`setup target must not be a symlink: ${path}`);
      return readFileSync(path);
    },
    replaceAtomically(path, bytes) {
      replaceFileAtomically(path, bytes);
    },
    remove(path) {
      if (existsSync(path)) rmSync(path);
    },
  };
}
