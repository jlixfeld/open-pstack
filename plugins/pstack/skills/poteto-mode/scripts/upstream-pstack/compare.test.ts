import { describe, expect, it } from "bun:test";
import {
  compareUpstream,
  renderComparison,
  type BlobEvidence,
  type Change,
} from "./compare.ts";
import { collectBlobEvidence } from "./facts.ts";
import { parseNameStatus, type GitClient } from "./git.ts";

const BASE = "bdf7aa355337897f167153e05069aca505dae17c";
const HEAD = "68836ddaf5697224520f1847d90cdb90ca8babaa";

function evidence(
  upstreamPath: string,
  recordedBlob: string | null,
  localHeadBlob: string | null
): BlobEvidence {
  return {
    upstreamPath,
    mapping:
      upstreamPath === "pstack/README.md"
        ? { kind: "upstream-readme", localPath: "README-UPSTREAM.md" }
        : upstreamPath.startsWith("pstack/.cursor-plugin/")
          ? { kind: "cursor-only-metadata" }
          : {
              kind: "shared-path",
              localPath: `plugins/pstack/${upstreamPath.slice("pstack/".length)}`,
            },
    recordedBlob,
    localHeadBlob,
  };
}

function comparison(changes: readonly Change[], facts: readonly BlobEvidence[]) {
  return compareUpstream({
    recordedCommit: BASE,
    upstreamHead: HEAD,
    history: "linear",
    changes,
    evidence: facts,
  });
}

describe("compareUpstream", () => {
  it("reports no drift when the upstream pstack tree has no changes", () => {
    const result = comparison([], []);
    expect(result.hasDrift).toBe(false);
    expect(result.changes).toEqual([]);
    expect(renderComparison(result)).toContain("changed_pstack_files:\n(none)");
  });

  it("ignores changes outside pstack", () => {
    const result = comparison(
      [{ kind: "modified", path: "cursor-team-kit/SKILL.md" }],
      []
    );
    expect(result.hasDrift).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it("does not mark an unchanged imported local file as fork overlap", () => {
    const result = comparison(
      [{ kind: "modified", path: "pstack/skills/arena/SKILL.md" }],
      [evidence("pstack/skills/arena/SKILL.md", "same", "same")]
    );
    expect(result.overlaps).toEqual([]);
  });

  it("marks a locally adapted file when its HEAD blob differs from the recorded base", () => {
    const result = comparison(
      [{ kind: "modified", path: "pstack/skills/arena/SKILL.md" }],
      [evidence("pstack/skills/arena/SKILL.md", "base", "adapted")]
    );
    expect(result.overlaps).toEqual([
      {
        upstreamPath: "pstack/skills/arena/SKILL.md",
        localPath: "plugins/pstack/skills/arena/SKILL.md",
        recordedBlob: "base",
        localHeadBlob: "adapted",
      },
    ]);
  });

  it("covers add, delete, rename, README mapping, and Cursor-only metadata", () => {
    const result = comparison(
      [
        { kind: "added", path: "pstack/skills/new/SKILL.md" },
        { kind: "deleted", path: "pstack/skills/old/SKILL.md" },
        {
          kind: "renamed",
          from: "pstack/skills/old-name/SKILL.md",
          path: "pstack/skills/new-name/SKILL.md",
        },
        { kind: "modified", path: "pstack/README.md" },
        { kind: "modified", path: "pstack/.cursor-plugin/plugin.json" },
      ],
      [
        evidence("pstack/skills/new/SKILL.md", null, "local-add"),
        evidence("pstack/skills/old/SKILL.md", "base-delete", null),
        evidence("pstack/skills/old-name/SKILL.md", "base-rename", "base-rename"),
        evidence("pstack/skills/new-name/SKILL.md", null, "local-rename"),
        evidence("pstack/README.md", "base-readme", "adapted-readme"),
        evidence("pstack/.cursor-plugin/plugin.json", null, null),
      ]
    );
    expect(result.overlaps.map((overlap) => overlap.upstreamPath)).toEqual([
      "pstack/README.md",
      "pstack/skills/new-name/SKILL.md",
      "pstack/skills/new/SKILL.md",
      "pstack/skills/old/SKILL.md",
    ]);
    expect(result.overlaps[0]?.localPath).toBe("README-UPSTREAM.md");
    expect(result.cursorOnlyMetadata).toEqual([
      "pstack/.cursor-plugin/plugin.json",
    ]);
  });

  it("renders equivalent input in a deterministic order", () => {
    const changes: readonly Change[] = [
      { kind: "modified", path: "pstack/z.md" },
      { kind: "added", path: "pstack/a.md" },
    ];
    const facts = [
      evidence("pstack/z.md", "same", "same"),
      evidence("pstack/a.md", "base", "local"),
    ];
    expect(renderComparison(comparison(changes, facts))).toBe(
      renderComparison(comparison([...changes].reverse(), [...facts].reverse()))
    );
  });
});

it("collects blob evidence through GitClient and does not read local Cursor metadata", async () => {
  const calls: string[] = [];
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
    async blobAt(ref: string, path: string) {
      calls.push(`${ref}:${path}`);
      return "blob";
    },
  } satisfies GitClient;
  const facts = await collectBlobEvidence({
    git,
    recordedCommit: BASE,
    changes: [
      { kind: "modified", path: "pstack/README.md" },
      { kind: "modified", path: "pstack/.cursor-plugin/plugin.json" },
    ],
  });
  expect(calls).toEqual([`${BASE}:pstack/README.md`, "HEAD:README-UPSTREAM.md"]);
  expect(facts[0]?.mapping).toEqual({ kind: "cursor-only-metadata" });
  expect(facts[1]?.mapping).toEqual({
    kind: "upstream-readme",
    localPath: "README-UPSTREAM.md",
  });
});

it("parses git add, modify, delete, and rename records", () => {
  expect(
    parseNameStatus(
      "A\0pstack/a.md\0M\0pstack/b.md\0D\0pstack/c.md\0R100\0pstack/from.md\0pstack/to.md\0"
    )
  ).toEqual([
    { kind: "added", path: "pstack/a.md" },
    { kind: "modified", path: "pstack/b.md" },
    { kind: "deleted", path: "pstack/c.md" },
    { kind: "renamed", from: "pstack/from.md", path: "pstack/to.md" },
  ]);
});
