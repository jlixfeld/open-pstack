import { spawn } from "node:child_process";
import type { Change } from "./compare.ts";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitClient {
  fetchCursorDefaultBranch(): Promise<string>;
  resolveCommit(ref: string): Promise<string>;
  isAncestor(base: string, head: string): Promise<boolean>;
  changedPstackFiles(base: string, head: string): Promise<readonly Change[]>;
  blobAt(ref: string, path: string): Promise<string | null>;
}

function run(argv: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function commandError(argv: readonly string[], result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(`${argv.join(" ")} exited ${result.code}${detail ? `: ${detail}` : ""}`);
}

function field(fields: readonly string[], index: number, status: string): string {
  const value = fields[index];
  if (value === undefined || value === "")
    throw new Error(`invalid git diff record for ${status}`);
  return value;
}

export function parseNameStatus(output: string): readonly Change[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: Change[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = field(fields, index, "status");
    index += 1;
    if (status.startsWith("R")) {
      const from = field(fields, index, status);
      const path = field(fields, index + 1, status);
      index += 2;
      changes.push({ kind: "renamed", from, path });
      continue;
    }
    const path = field(fields, index, status);
    index += 1;
    if (status === "A") changes.push({ kind: "added", path });
    else if (status === "M" || status === "T")
      changes.push({ kind: "modified", path });
    else if (status === "D") changes.push({ kind: "deleted", path });
    else throw new Error(`unsupported git diff status ${status}`);
  }
  return changes;
}

export class ShellGitClient implements GitClient {
  async fetchCursorDefaultBranch(): Promise<string> {
    const argv = ["git", "fetch", "--no-tags", "cursor-upstream", "main"];
    const result = await run(argv);
    if (result.code !== 0) throw commandError(argv, result);
    return "cursor-upstream/main";
  }

  async resolveCommit(ref: string): Promise<string> {
    const argv = ["git", "rev-parse", "--verify", `${ref}^{commit}`];
    const result = await run(argv);
    if (result.code !== 0) throw commandError(argv, result);
    const sha = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new Error(`git did not resolve ${ref} to a full SHA`);
    return sha;
  }

  async isAncestor(base: string, head: string): Promise<boolean> {
    const argv = ["git", "merge-base", "--is-ancestor", base, head];
    const result = await run(argv);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw commandError(argv, result);
  }

  async changedPstackFiles(base: string, head: string): Promise<readonly Change[]> {
    const argv = [
      "git",
      "diff",
      "--name-status",
      "-z",
      "-M",
      `${base}..${head}`,
      "--",
      "pstack/",
    ];
    const result = await run(argv);
    if (result.code !== 0) throw commandError(argv, result);
    return parseNameStatus(result.stdout);
  }

  async blobAt(ref: string, path: string): Promise<string | null> {
    const argv = ["git", "rev-parse", "--verify", "--quiet", `${ref}:${path}`];
    const result = await run(argv);
    if (result.code === 1) return null;
    if (result.code !== 0) throw commandError(argv, result);
    const blob = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(blob))
      throw new Error(`git did not resolve ${ref}:${path} to a blob SHA`);
    return blob;
  }
}
