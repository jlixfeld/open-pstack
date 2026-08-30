import { readFile } from "node:fs/promises";
import {
  compareUpstream,
  renderComparison,
} from "./compare.ts";
import { collectBlobEvidence } from "./facts.ts";
import { ShellGitClient, type GitClient } from "./git.ts";
import {
  GhIssueClient,
  decideIssueTransition,
  type GitHubIssueClient,
} from "./github.ts";

export interface CliOptions {
  readonly upstreamRef: string | null;
  readonly repo: string | null;
  readonly upstreamFile: string | null;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let upstreamRef: string | null = null;
  let repo: string | null = null;
  let upstreamFile: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--upstream-ref" || option === "--repo" || option === "--upstream-file") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${option} requires a value`);
      if (option === "--upstream-ref") upstreamRef = value;
      else if (option === "--repo") repo = value;
      else upstreamFile = value;
      index += 1;
      continue;
    }
    if (option === "--help")
      throw new Error(
        "usage: pstack-upstream [--upstream-ref <ref>] [--repo <owner/repo>] [--upstream-file <path>]"
      );
    throw new Error(`unknown option ${option}`);
  }
  return { upstreamRef, repo, upstreamFile };
}

export function recordedCommit(upstream: string): string {
  const match = upstream.match(/^\| Commit \| `([0-9a-f]{40})` \|$/m);
  if (match?.[1] === undefined)
    throw new Error("UPSTREAM.md has no full content-sync Commit value");
  return match[1];
}

export interface CliRuntime {
  readonly git: GitClient;
  readonly github: GitHubIssueClient;
  readonly readFile: (path: string) => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

function realRuntime(): CliRuntime {
  return {
    git: new ShellGitClient(),
    github: new GhIssueClient(),
    readFile: (path) => readFile(path, "utf8"),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

async function readUpstream(
  runtime: CliRuntime,
  requestedPath: string | null
): Promise<string> {
  if (requestedPath !== null) return runtime.readFile(requestedPath);
  try {
    return await runtime.readFile("UPSTREAM.md");
  } catch {
    return runtime.readFile("../../../../../UPSTREAM.md");
  }
}

export async function main(
  argv: readonly string[],
  runtime: CliRuntime = realRuntime()
): Promise<number> {
  try {
    const options = parseArgs(argv);
    const base = recordedCommit(await readUpstream(runtime, options.upstreamFile));
    const ref = options.upstreamRef ?? (await runtime.git.fetchCursorDefaultBranch());
    const head = await runtime.git.resolveCommit(ref);
    const changes = await runtime.git.changedPstackFiles(base, head);
    const comparison = compareUpstream({
      recordedCommit: base,
      upstreamHead: head,
      history: (await runtime.git.isAncestor(base, head)) ? "linear" : "diverged",
      changes,
      evidence: await collectBlobEvidence({
        git: runtime.git,
        recordedCommit: base,
        changes,
      }),
    });
    runtime.stdout(renderComparison(comparison));
    if (options.repo === null) return 0;
    const transition = decideIssueTransition({
      comparison,
      issues: await runtime.github.managedIssues(options.repo),
    });
    await runtime.github.apply(options.repo, transition);
    runtime.stdout(`issue_action=${transition.kind}\n`);
    return 0;
  } catch (error) {
    runtime.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
