export const MONITOR_MARKER = "<!-- open-pstack:upstream-pstack-monitor -->";

export type Change =
  | { readonly kind: "added"; readonly path: string }
  | { readonly kind: "modified"; readonly path: string }
  | { readonly kind: "deleted"; readonly path: string }
  | { readonly kind: "renamed"; readonly from: string; readonly path: string };

export type PathMapping =
  | { readonly kind: "shared-path"; readonly localPath: string }
  | { readonly kind: "upstream-readme"; readonly localPath: "README-UPSTREAM.md" }
  | { readonly kind: "cursor-only-metadata" };

export interface BlobEvidence {
  readonly upstreamPath: string;
  readonly mapping: PathMapping;
  readonly recordedBlob: string | null;
  readonly localHeadBlob: string | null;
}

export interface Overlap {
  readonly upstreamPath: string;
  readonly localPath: string;
  readonly recordedBlob: string | null;
  readonly localHeadBlob: string | null;
}

export interface UpstreamComparison {
  readonly recordedCommit: string;
  readonly upstreamHead: string;
  readonly history: "linear" | "diverged";
  readonly rangeUrl: string;
  readonly changes: readonly Change[];
  readonly cursorOnlyMetadata: readonly string[];
  readonly overlaps: readonly Overlap[];
  readonly hasDrift: boolean;
}

export function mapUpstreamPath(path: string): PathMapping {
  if (path === "pstack/README.md")
    return { kind: "upstream-readme", localPath: "README-UPSTREAM.md" };
  if (
    path.startsWith("pstack/.cursor-plugin/") ||
    path.startsWith("pstack/.cursor/")
  )
    return { kind: "cursor-only-metadata" };
  if (!path.startsWith("pstack/"))
    throw new Error(`cannot map a path outside pstack/: ${path}`);
  return {
    kind: "shared-path",
    localPath: `plugins/pstack/${path.slice("pstack/".length)}`,
  };
}

export function changePaths(change: Change): readonly string[] {
  return change.kind === "renamed" ? [change.from, change.path] : [change.path];
}

function compareChange(left: Change, right: Change): number {
  const leftKey = `${left.path}\u0000${left.kind}\u0000${left.kind === "renamed" ? left.from : ""}`;
  const rightKey = `${right.path}\u0000${right.kind}\u0000${right.kind === "renamed" ? right.from : ""}`;
  return leftKey.localeCompare(rightKey);
}

function compareEvidence(left: BlobEvidence, right: BlobEvidence): number {
  return left.upstreamPath.localeCompare(right.upstreamPath);
}

function evidenceForChanges(
  changes: readonly Change[],
  evidence: readonly BlobEvidence[]
): readonly BlobEvidence[] {
  const paths = new Set(changes.flatMap(changePaths));
  const byPath = new Map<string, BlobEvidence>();
  for (const fact of evidence) {
    if (byPath.has(fact.upstreamPath))
      throw new Error(`duplicate blob evidence for ${fact.upstreamPath}`);
    byPath.set(fact.upstreamPath, fact);
  }
  return [...paths]
    .map((path) => {
      const fact = byPath.get(path);
      if (fact === undefined) throw new Error(`missing blob evidence for ${path}`);
      return fact;
    })
    .sort(compareEvidence);
}

export function compareUpstream(args: {
  readonly recordedCommit: string;
  readonly upstreamHead: string;
  readonly history: "linear" | "diverged";
  readonly changes: readonly Change[];
  readonly evidence: readonly BlobEvidence[];
}): UpstreamComparison {
  const changes = [...args.changes]
    .filter((change) => changePaths(change).some((path) => path.startsWith("pstack/")))
    .sort(compareChange);
  const facts = evidenceForChanges(changes, args.evidence);
  const cursorOnlyMetadata = facts
    .filter((fact) => fact.mapping.kind === "cursor-only-metadata")
    .map((fact) => fact.upstreamPath);
  const overlaps = facts
    .filter(
      (fact): fact is BlobEvidence & {
        readonly mapping: Exclude<PathMapping, { readonly kind: "cursor-only-metadata" }>;
      } =>
        fact.mapping.kind !== "cursor-only-metadata" &&
        fact.recordedBlob !== fact.localHeadBlob
    )
    .map((fact) => ({
      upstreamPath: fact.upstreamPath,
      localPath: fact.mapping.localPath,
      recordedBlob: fact.recordedBlob,
      localHeadBlob: fact.localHeadBlob,
    }));
  return {
    recordedCommit: args.recordedCommit,
    upstreamHead: args.upstreamHead,
    history: args.history,
    rangeUrl: `https://github.com/cursor/plugins/compare/${args.recordedCommit}...${args.upstreamHead}`,
    changes,
    cursorOnlyMetadata,
    overlaps,
    hasDrift: changes.length !== 0,
  };
}

export function renderChange(change: Change): string {
  switch (change.kind) {
    case "added":
      return `A ${change.path}`;
    case "modified":
      return `M ${change.path}`;
    case "deleted":
      return `D ${change.path}`;
    case "renamed":
      return `R ${change.from} → ${change.path}`;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

export function renderComparison(comparison: UpstreamComparison): string {
  const lines = [
    `recorded_commit=${comparison.recordedCommit}`,
    `upstream_head=${comparison.upstreamHead}`,
    `history=${comparison.history}`,
    `range_url=${comparison.rangeUrl}`,
    "changed_pstack_files:",
    ...(comparison.changes.length === 0
      ? ["(none)"]
      : comparison.changes.map(renderChange)),
    "fork_mapping_overlap:",
    ...(comparison.overlaps.length === 0
      ? ["(none)"]
      : comparison.overlaps.map(
          (overlap) =>
            `${overlap.upstreamPath} -> ${overlap.localPath} (recorded=${overlap.recordedBlob ?? "missing"}, local=${overlap.localHeadBlob ?? "missing"})`
        )),
    "cursor_only_metadata:",
    ...(comparison.cursorOnlyMetadata.length === 0
      ? ["(none)"]
      : comparison.cursorOnlyMetadata),
  ];
  return `${lines.join("\n")}\n`;
}
