import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function errorCode(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function writeFileAtomically(
  path: string,
  contents: string | Uint8Array,
  mode?: number
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, contents, {
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
