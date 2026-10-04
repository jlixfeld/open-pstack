# open-pstack

Track all durable work in this repository's GitHub Issues. Do not create a parallel Linear queue. Read `UPSTREAM.md` before changing upstream-derived content.

Cursor's `cursor/plugins/pstack` tree is the content upstream. Keep one shared skill tree for Claude Code and Codex; adapt harness primitives at the existing mapping boundaries instead of forking skills or adding compatibility layers. The parent harness resolves provider routing once. Children do not detect or reroute themselves.

Before opening a pull request, run the Bun tests, strict typecheck, static invariants, and plugin validation.

Nothing merges, tags, releases, or rolls out until the exact candidate is installed and the changed behavior passes a live test from the real user surface in every affected active deployment target. Unit tests, validators, source inspection, and self-reports do not satisfy this gate. Record the installed version, surface, action, and observed result in the pull request template. A pull request without that evidence remains a draft. Declare active deployment targets before validation. For Jason's current deployment, Codex is active; Claude is unused. Preserve Claude adapters and run their static checks, but record Claude runtime as not tested and do not claim live compatibility or require Claude login, installation, or model execution. A later deployment to Claude requires its own live evidence before rollout.

Do not add an implicit runtime timeout or a weaker-model fallback.

## Release completion

Treat a proper release as part of completing changes to the distributed PStack plugin. Do not finish a plugin update with merged changes still carrying the previous release version. Unless the user explicitly asks to defer publication, carry the authorized work through a reviewed release PR, passing CI, merge, an annotated `vX.Y.Z` tag at the merged commit, and a published GitHub release with truthful verification notes.

Choose the semantic version from the compatibility impact. Keep the Claude marketplace entry, Claude plugin manifest, Codex plugin manifest, current documentation, `UPSTREAM.md`, and `CHANGES.md` consistent. Update package or lock metadata only when it actually carries the distribution version. Preserve historical release entries. Documentation-only maintenance does not require a plugin release unless it changes shipped workflow instructions or the user requests one.

After publication, use the supported Codex marketplace refresh and plugin install commands to update the user's installed plugin when that installation is in scope. Verify the installed version and source against the tagged commit, and compare before/after hashes of the personal model sheet and its harness integration. Preserve both byte-for-byte unless the user explicitly requests model configuration changes. Do not restart the app or interrupt running agents; explain that a new session may be needed to load refreshed instructions.

Check existing PRs, tags, and releases before creating publication state so retries do not create duplicates. Never silently overwrite a published tag or release. Record deferred harness validation explicitly rather than claiming it passed. If automatic approval review blocks an authorized publication step, report the exact blocked action and reason; do not call the update complete.
