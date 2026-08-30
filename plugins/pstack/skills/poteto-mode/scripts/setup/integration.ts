import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SetupFilesystem } from "./transaction.ts";

export function nodeFilesystem(): SetupFilesystem {
  return {
    read(path) {
      return existsSync(path) ? readFileSync(path) : null;
    },
    replaceAtomically(path, bytes) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = join(dirname(path), `.${Date.now()}-${Math.random().toString(16).slice(2)}.pstack`);
      try {
        writeFileSync(temporary, bytes, { mode: 0o600 });
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
