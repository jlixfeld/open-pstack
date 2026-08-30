import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellGitClient } from "./git.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ShellGitClient", () => {
  it("finds pstack changes from a nested working directory", async () => {
    const repository = mkdtempSync(join(tmpdir(), "pstack-git-client-"));
    directories.push(repository);
    execFileSync("git", ["init", "-q"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
    mkdirSync(join(repository, "pstack"));
    mkdirSync(join(repository, "nested"));
    writeFileSync(join(repository, "pstack", "README.md"), "before\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repository });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    writeFileSync(join(repository, "pstack", "README.md"), "after\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-qm", "change"], { cwd: repository });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

    await expect(new ShellGitClient(join(repository, "nested")).changedPstackFiles(base, head)).resolves.toEqual([
      { kind: "modified", path: "pstack/README.md" },
    ]);
  });
});
