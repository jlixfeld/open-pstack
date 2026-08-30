import { spawn } from "node:child_process";
import {
  decideIssueTransition,
  type IssueTransition,
  type ManagedIssue,
} from "./issues.ts";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitHubIssueClient {
  managedIssues(repo: string): Promise<readonly ManagedIssue[]>;
  apply(repo: string, transition: IssueTransition): Promise<void>;
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

function ensureSuccess(argv: readonly string[], result: CommandResult): void {
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(`${argv.join(" ")} exited ${result.code}${detail ? `: ${detail}` : ""}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIssue(value: unknown): ManagedIssue | null {
  if (!isRecord(value)) throw new Error("GitHub returned a non-object issue");
  if ("pull_request" in value) return null;
  const number = value.number;
  const state = value.state;
  const body = value.body;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0)
    throw new Error("GitHub issue has an invalid number");
  if (state !== "open" && state !== "closed")
    throw new Error("GitHub issue has an invalid state");
  if (body !== null && typeof body !== "string")
    throw new Error("GitHub issue has an invalid body");
  return { number, state, body: body ?? "" };
}

export function parseJsonArrays(text: string): readonly unknown[] {
  const values: unknown[] = [];
  let offset = 0;
  while (offset < text.length) {
    while (/\s/.test(text[offset] ?? "")) offset += 1;
    if (offset === text.length) break;
    if (text[offset] !== "[")
      throw new Error("GitHub pagination output does not start with an array");
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = offset;
    for (; end < text.length; end += 1) {
      const character = text[end] ?? "";
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "[") depth += 1;
      else if (character === "]") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error("GitHub pagination output has an unclosed array");
    const parsed: unknown = JSON.parse(text.slice(offset, end + 1));
    if (!Array.isArray(parsed)) throw new Error("GitHub pagination output is not an array");
    values.push(...parsed);
    offset = end + 1;
  }
  return values;
}

function validateRepo(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("--repo must be owner/repository");
  return repo;
}

export class GhIssueClient implements GitHubIssueClient {
  async managedIssues(repo: string): Promise<readonly ManagedIssue[]> {
    const validRepo = validateRepo(repo);
    const argv = [
      "gh",
      "api",
      "--paginate",
      "--method",
      "GET",
      `repos/${validRepo}/issues?state=all&per_page=100`,
    ];
    const result = await run(argv);
    ensureSuccess(argv, result);
    return parseJsonArrays(result.stdout)
      .map(parseIssue)
      .filter((issue): issue is ManagedIssue => issue !== null);
  }

  async apply(repo: string, transition: IssueTransition): Promise<void> {
    const validRepo = validateRepo(repo);
    if (transition.kind === "no-op") return;
    if (transition.kind === "create") {
      const argv = [
        "gh",
        "issue",
        "create",
        "--repo",
        validRepo,
        "--title",
        transition.title,
        "--body",
        transition.body,
      ];
      ensureSuccess(argv, await run(argv));
      return;
    }
    if (transition.kind === "update") {
      const argv = [
        "gh",
        "issue",
        "edit",
        String(transition.number),
        "--repo",
        validRepo,
        "--body",
        transition.body,
      ];
      ensureSuccess(argv, await run(argv));
      return;
    }
    if (transition.kind === "reopen") {
      const reopen = [
        "gh",
        "issue",
        "reopen",
        String(transition.number),
        "--repo",
        validRepo,
      ];
      ensureSuccess(reopen, await run(reopen));
      const update = [
        "gh",
        "issue",
        "edit",
        String(transition.number),
        "--repo",
        validRepo,
        "--body",
        transition.body,
      ];
      ensureSuccess(update, await run(update));
      return;
    }
    const close = [
      "gh",
      "issue",
      "close",
      String(transition.number),
      "--repo",
      validRepo,
      "--comment",
      transition.comment,
    ];
    ensureSuccess(close, await run(close));
  }
}

export { decideIssueTransition };
