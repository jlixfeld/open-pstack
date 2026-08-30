import { changePaths, mapUpstreamPath, type BlobEvidence, type Change } from "./compare.ts";
import type { GitClient } from "./git.ts";

export async function collectBlobEvidence(args: {
  readonly git: GitClient;
  readonly recordedCommit: string;
  readonly changes: readonly Change[];
}): Promise<readonly BlobEvidence[]> {
  const paths = [
    ...new Set(
      args.changes
        .flatMap(changePaths)
        .filter((path) => path.startsWith("pstack/"))
    ),
  ].sort((left, right) => left.localeCompare(right));
  return Promise.all(
    paths.map(async (upstreamPath) => {
      const mapping = mapUpstreamPath(upstreamPath);
      if (mapping.kind === "cursor-only-metadata")
        return {
          upstreamPath,
          mapping,
          recordedBlob: null,
          localHeadBlob: null,
        };
      const [recordedBlob, localHeadBlob] = await Promise.all([
        args.git.blobAt(args.recordedCommit, upstreamPath),
        args.git.blobAt("HEAD", mapping.localPath),
      ]);
      return { upstreamPath, mapping, recordedBlob, localHeadBlob };
    })
  );
}
