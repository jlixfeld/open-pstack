import {
  MONITOR_MARKER,
  renderChange,
  type UpstreamComparison,
} from "./compare.ts";

export interface ManagedIssue {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly body: string;
}

export type IssueTransition =
  | { readonly kind: "create"; readonly title: string; readonly body: string }
  | { readonly kind: "update"; readonly number: number; readonly body: string }
  | { readonly kind: "reopen"; readonly number: number; readonly body: string }
  | { readonly kind: "close"; readonly number: number; readonly comment: string }
  | { readonly kind: "no-op" };

export class DuplicateManagedIssuesError extends Error {
  constructor(numbers: readonly number[]) {
    super(`multiple ${MONITOR_MARKER} issues exist: ${numbers.join(", ")}`);
    this.name = "DuplicateManagedIssuesError";
  }
}

export const ISSUE_TITLE = "Upstream pstack drift detected";

export function renderIssueBody(comparison: UpstreamComparison): string {
  return [
    MONITOR_MARKER,
    "# Cursor pstack drift",
    "",
    "The Cursor upstream has changes under `pstack/` that are not in the recorded content sync point. This is a tracking issue only; it does not authorize a direct sync.",
    "",
    "## Sync range",
    "",
    `- Recorded content-sync commit: [\`${comparison.recordedCommit}\`](https://github.com/cursor/plugins/commit/${comparison.recordedCommit})`,
    `- Observed Cursor head: [\`${comparison.upstreamHead}\`](https://github.com/cursor/plugins/commit/${comparison.upstreamHead})`,
    `- [View the upstream range](${comparison.rangeUrl})`,
    `- History: \`${comparison.history}\``,
    "",
    "## Changed pstack files",
    "",
    ...comparison.changes.map((change) => `- \`${renderChange(change)}\``),
    "",
    "## Fork-specific overlap",
    "",
    ...(comparison.overlaps.length === 0
      ? ["- None: every mapped local `HEAD` blob matches the recorded Cursor-base blob."]
      : comparison.overlaps.map(
          (overlap) =>
            `- \`${overlap.upstreamPath}\` → \`${overlap.localPath}\` (recorded \`${overlap.recordedBlob ?? "missing"}\`; local \`${overlap.localHeadBlob ?? "missing"}\`)`
        )),
    "",
    "## Cursor-only metadata",
    "",
    ...(comparison.cursorOnlyMetadata.length === 0
      ? ["- None"]
      : comparison.cursorOnlyMetadata.map((path) => `- \`${path}\``)),
    "",
    "Backport each Lauren change on its own branch and PR. Advance `UPSTREAM.md` only after that PR has passed the required verification. Preserve the fork adaptations and tiered routing; Eric port updates use `port-upstream` on their own branches and PRs.",
    "",
    "- Codex",
    "",
  ].join("\n");
}

export function renderCloseComment(comparison: UpstreamComparison): string {
  return [
    MONITOR_MARKER,
    "The recorded content-sync commit now covers the current upstream `pstack/` tree.",
    "",
    `[Range checked](${comparison.rangeUrl})`,
    "",
    "- Codex",
    "",
  ].join("\n");
}

function managed(issues: readonly ManagedIssue[]): readonly ManagedIssue[] {
  return issues.filter((issue) => issue.body.includes(MONITOR_MARKER));
}

export function decideIssueTransition(args: {
  readonly comparison: UpstreamComparison;
  readonly issues: readonly ManagedIssue[];
}): IssueTransition {
  const matching = managed(args.issues);
  if (matching.length > 1)
    throw new DuplicateManagedIssuesError(matching.map((issue) => issue.number));
  const issue = matching[0] ?? null;
  if (!args.comparison.hasDrift) {
    if (issue === null || issue.state === "closed") return { kind: "no-op" };
    return {
      kind: "close",
      number: issue.number,
      comment: renderCloseComment(args.comparison),
    };
  }
  const body = renderIssueBody(args.comparison);
  if (issue === null) return { kind: "create", title: ISSUE_TITLE, body };
  if (issue.state === "closed") return { kind: "reopen", number: issue.number, body };
  return issue.body === body
    ? { kind: "no-op" }
    : { kind: "update", number: issue.number, body };
}
