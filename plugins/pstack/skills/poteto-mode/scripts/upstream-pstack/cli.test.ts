import { describe, expect, it } from "bun:test";
import { DEFAULT_UPSTREAM_PATH, main, recordedCommit, type CliRuntime } from "./cli.ts";
import type { GitClient } from "./git.ts";
import type { GitHubIssueClient } from "./github.ts";
import type { IssueTransition } from "./issues.ts";

const BASE = "bdf7aa355337897f167153e05069aca505dae17c";
const HEAD = "68836ddaf5697224520f1847d90cdb90ca8babaa";

function runtime(args: {
  readonly git: GitClient;
  readonly github?: GitHubIssueClient;
  readonly upstream?: string;
  readonly readFile?: (path: string) => Promise<string>;
}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const github = args.github ?? {
    async managedIssues() {
      return [];
    },
    async apply(_repo: string, _transition: IssueTransition) {},
  } satisfies GitHubIssueClient;
  return {
    stdout,
    stderr,
    runtime: {
      git: args.git,
      github,
      readFile:
        args.readFile ??
        (async () => args.upstream ?? `| Commit | \`${BASE}\` |\n`),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    } satisfies CliRuntime,
  };
}

describe("main", () => {
  it("accepts a supplied default-branch ref without fetching", async () => {
    let fetches = 0;
    const git = {
      async fetchCursorDefaultBranch() {
        fetches += 1;
        return "cursor-upstream/main";
      },
      async resolveCommit(ref: string) {
        expect(ref).toBe("cursor-upstream/main");
        return HEAD;
      },
      async isAncestor() {
        return true;
      },
      async changedPstackFiles() {
        return [
          { kind: "modified", path: "pstack/skills/arena/SKILL.md" },
        ];
      },
      async blobAt() {
        return "same";
      },
    } satisfies GitClient;
    const test = runtime({ git });
    expect(await main(["--upstream-ref", "cursor-upstream/main"], test.runtime)).toBe(0);
    expect(fetches).toBe(0);
    expect(test.stdout.join("")).toContain(`recorded_commit=${BASE}`);
    expect(test.stderr).toEqual([]);
  });

  it("fetches the cursor default branch when no ref is supplied", async () => {
    const git = {
      async fetchCursorDefaultBranch() {
        return "cursor-upstream/main";
      },
      async resolveCommit() {
        return HEAD;
      },
      async isAncestor() {
        return false;
      },
      async changedPstackFiles() {
        return [];
      },
      async blobAt() {
        return null;
      },
    } satisfies GitClient;
    const test = runtime({ git });
    expect(await main([], test.runtime)).toBe(0);
    expect(test.stdout.join("")).toContain("history=diverged");
  });

  it("reads the repository UPSTREAM.md independently of the current directory", async () => {
    const paths: string[] = [];
    const git = {
      async fetchCursorDefaultBranch() {
        return "cursor-upstream/main";
      },
      async resolveCommit() {
        return HEAD;
      },
      async isAncestor() {
        return true;
      },
      async changedPstackFiles() {
        return [];
      },
      async blobAt() {
        return null;
      },
    } satisfies GitClient;
    const test = runtime({
      git,
      readFile: async (path) => {
        paths.push(path);
        return `| Commit | \`${BASE}\` |\n`;
      },
    });
    expect(await main([], test.runtime)).toBe(0);
    expect(paths).toEqual([DEFAULT_UPSTREAM_PATH]);
  });
});

it("reads only the full content-sync commit table value", () => {
  expect(recordedCommit(`| Commit | \`${BASE}\` |`)).toBe(BASE);
  expect(() => recordedCommit("| Commit | `short` |")).toThrow(
    "UPSTREAM.md has no full content-sync Commit value"
  );
});
