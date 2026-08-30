import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SetupFilesystem } from "./transaction.ts";

export function nodeFilesystem(): SetupFilesystem {
  return {
    read(path) {
      if (!existsSync(path)) return null;
      if (lstatSync(path).isSymbolicLink()) throw new Error(`setup target must not be a symlink: ${path}`);
      return readFileSync(path);
    },
    replaceAtomically(path, bytes) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`setup target must not be a symlink: ${path}`);
      mkdirSync(dirname(path), { recursive: true });
      const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
      const temporary = join(dirname(path), `.${Date.now()}-${Math.random().toString(16).slice(2)}.pstack`);
      try {
        writeFileSync(temporary, bytes, { mode });
        renameSync(temporary, path);
      } finally {
        if (existsSync(temporary)) rmSync(temporary);
      }
    },
    remove(path) {
      if (existsSync(path)) rmSync(path);
    },
  };
}
