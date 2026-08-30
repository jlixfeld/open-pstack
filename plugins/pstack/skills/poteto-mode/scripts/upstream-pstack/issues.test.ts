import { describe, expect, it } from "bun:test";
import { compareUpstream, MONITOR_MARKER } from "./compare.ts";
import {
  decideIssueTransition,
  DuplicateManagedIssuesError,
  renderCloseComment,
  renderIssueBody,
  type ManagedIssue,
} from "./issues.ts";

const comparison = (hasDrift: boolean) =>
  compareUpstream({
    recordedCommit: "bdf7aa355337897f167153e05069aca505dae17c",
    upstreamHead: "68836ddaf5697224520f1847d90cdb90ca8babaa",
    history: "linear",
    changes: hasDrift
      ? [{ kind: "modified", path: "pstack/skills/arena/SKILL.md" }]
      : [],
    evidence: hasDrift
      ? [
          {
            upstreamPath: "pstack/skills/arena/SKILL.md",
            mapping: {
              kind: "shared-path",
              localPath: "plugins/pstack/skills/arena/SKILL.md",
            },
            recordedBlob: "base",
            localHeadBlob: "adapted",
          },
        ]
      : [],
  });

const managed = (state: ManagedIssue["state"], body: string): ManagedIssue => ({
  number: 41,
  state,
  body,
});

describe("decideIssueTransition", () => {
  it("creates once for drift", () => {
    expect(decideIssueTransition({ comparison: comparison(true), issues: [] })).toMatchObject({
      kind: "create",
    });
  });

  it("does nothing only when the open issue body is exactly the deterministic body", () => {
    const current = comparison(true);
    const body = renderIssueBody(current);
    expect(body).toBe(renderIssueBody(current));
    expect(
      decideIssueTransition({
        comparison: current,
        issues: [managed("open", body)],
      })
    ).toEqual({ kind: "no-op" });
  });

  it("updates a stale open issue", () => {
    expect(
      decideIssueTransition({
        comparison: comparison(true),
        issues: [managed("open", `${MONITOR_MARKER}\nstale`)],
      })
    ).toMatchObject({ kind: "update", number: 41 });
  });

  it("reopens a closed issue when drift returns", () => {
    expect(
      decideIssueTransition({
        comparison: comparison(true),
        issues: [managed("closed", `${MONITOR_MARKER}\nold`)],
      })
    ).toMatchObject({ kind: "reopen", number: 41 });
  });

  it("closes the one open managed issue when the content sync catches up", () => {
    const current = comparison(false);
    expect(
      decideIssueTransition({
        comparison: current,
        issues: [managed("open", `${MONITOR_MARKER}\nold`)],
      })
    ).toEqual({
      kind: "close",
      number: 41,
      comment: renderCloseComment(current),
    });
  });

  it("does nothing when there is no managed issue or it is already closed", () => {
    expect(decideIssueTransition({ comparison: comparison(false), issues: [] })).toEqual({
      kind: "no-op",
    });
    expect(
      decideIssueTransition({
        comparison: comparison(false),
        issues: [managed("closed", `${MONITOR_MARKER}\nold`)],
      })
    ).toEqual({ kind: "no-op" });
  });

  it("fails closed when the stable marker has duplicate issues", () => {
    expect(() =>
      decideIssueTransition({
        comparison: comparison(true),
        issues: [
          managed("open", `${MONITOR_MARKER}\nfirst`),
          { number: 42, state: "closed", body: `${MONITOR_MARKER}\nsecond` },
        ],
      })
    ).toThrow(DuplicateManagedIssuesError);
  });
});

it("ends issue bodies and close comments with a separate Codex footer", () => {
  const body = renderIssueBody(comparison(true));
  expect(body).toContain("## Sync range");
  expect(body).toContain("bdf7aa355337897f167153e05069aca505dae17c");
  expect(body).toContain("68836ddaf5697224520f1847d90cdb90ca8babaa");
  expect(body).toContain("[View the upstream range](https://github.com/cursor/plugins/compare/");
  expect(body).toContain("## Changed pstack files");
  expect(body).toContain("## Fork-specific overlap");
  expect(body).toMatch(/\n- Codex\n$/);
  expect(renderCloseComment(comparison(false))).toMatch(/\n- Codex\n$/);
});
