import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs as parseRunnerArgs } from "../runner/cli.ts";
import {
  NotFoundError,
  UserError,
  openStore,
  parseVerdict,
  type OpenStoreOptions,
  type Store,
} from "./store.ts";

const SCRIPT = join(import.meta.dir, "orch.ts");
const directories: string[] = [];
const handles: Store[] = [];

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orch-test-"));
  directories.push(directory);
  return directory;
}

function useStore(
  directory: string,
  options?: OpenStoreOptions
): Store {
  const store = openStore(directory, options);
  handles.push(store);
  return store;
}

async function initializedStore(): Promise<{
  readonly directory: string;
  readonly store: Store;
}> {
  const directory = await makeDirectory();
  const store = useStore(directory);
  await store.init();
  return { directory, store };
}

function git({
  args,
  repo,
}: {
  args: readonly string[];
  repo: string;
}): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`
    );
  }
  return result.stdout.toString().trim();
}

async function makeGitStack(directory: string): Promise<{
  readonly repo: string;
  readonly mergedSha: string;
  readonly closedSha: string;
  readonly openSha: string;
}> {
  const repo = join(directory, "repo");
  await mkdir(repo);
  git({ repo, args: ["init", "--initial-branch=main"] });
  git({ repo, args: ["config", "user.name", "Orch Test"] });
  git({ repo, args: ["config", "user.email", "orch@example.com"] });
  await writeFile(join(repo, "main.txt"), "main\n");
  git({ repo, args: ["add", "."] });
  git({ repo, args: ["commit", "-m", "main"] });

  const branches = ["stack/merged", "stack/closed", "stack/open"];
  for (const [index, branch] of branches.entries()) {
    git({ repo, args: ["checkout", "-b", branch] });
    await writeFile(join(repo, `stack-${index}.txt`), `${branch}\n`);
    git({ repo, args: ["add", "."] });
    git({ repo, args: ["commit", "-m", branch] });
  }

  return {
    repo,
    mergedSha: git({ repo, args: ["rev-parse", "stack/merged"] }),
    closedSha: git({ repo, args: ["rev-parse", "stack/closed"] }),
    openSha: git({ repo, args: ["rev-parse", "stack/open"] }),
  };
}

async function withFakeGt<T>({
  directory,
  operation,
  output,
}: {
  directory: string;
  operation: (outputPath: string) => Promise<T>;
  output: string;
}): Promise<T> {
  const bin = join(directory, "bin");
  const outputPath = join(directory, "gt-output.txt");
  await mkdir(bin);
  await writeFile(outputPath, output);
  const gt = join(bin, "gt");
  await writeFile(
    gt,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$(pwd -P)" != "${realpathSync(join(directory, "repo"))}" ]; then
  printf 'gt ran outside the fixture repo: %s\\n' "$(pwd -P)" >&2
  exit 2
fi
case "$*" in
  "--no-interactive log short --stack --reverse")
    cat "${outputPath}"
    ;;
  "--no-interactive info stack/merged")
    printf 'stack/merged\\nPR #10 (Merged) merged change\\n'
    ;;
  "--no-interactive info stack/closed")
    printf 'stack/closed\\nPR #13 (Closed) closed change\\n'
    ;;
  "--no-interactive info stack/open")
    printf 'stack/open\\nPR #11 (Needs approvals) open change\\n'
    ;;
  *)
    printf 'unexpected gt arguments: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`
  );
  await chmod(gt, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  try {
    return await operation(outputPath);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
}

function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): RunResult {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

afterEach(async () => {
  for (const store of handles.splice(0).reverse()) {
    await store.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Store", () => {
  it("initializes an idempotent plain-file store and releases its lock", async () => {
    const directory = await makeDirectory();
    const store = useStore(directory);

    expect(await store.init()).toEqual({ store: directory });
    const firstUnits = await readFile(join(directory, "units.tsv"), "utf8");
    const firstLedger = await readFile(
      join(directory, "ledger.tsv"),
      "utf8"
    );
    const firstRegistry = await readFile(
      join(directory, "provider-lanes", "registry.json"),
      "utf8"
    );
    const firstLaneSentinel = await readFile(
      join(directory, ".orch.lane-registry.initialized"),
      "utf8"
    );
    expect(JSON.parse(firstRegistry)).toEqual({ schemaVersion: 1, lanes: [] });
    expect(firstLaneSentinel).toBe("provider-lanes-v1\n");

    expect(await store.init()).toEqual({ store: directory });
    expect(await readFile(join(directory, "units.tsv"), "utf8")).toBe(
      firstUnits
    );
    expect(await readFile(join(directory, "ledger.tsv"), "utf8")).toBe(
      firstLedger
    );
    expect(
      await readFile(join(directory, "provider-lanes", "registry.json"), "utf8")
    ).toBe(firstRegistry);
    expect(
      await readFile(join(directory, ".orch.lane-registry.initialized"), "utf8")
    ).toBe(firstLaneSentinel);
    expect((await readdir(directory)).sort()).toEqual([
      ".orch.lane-registry.initialized",
      ".orch.lock",
      "frontier.json",
      "gates.md",
      "inbox",
      "ledger.tsv",
      "preferences.md",
      "provider-lanes",
      "units.tsv",
    ]);

    await store.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("recovers first initialization after a registry atomic-write interruption", async () => {
    const directory = await makeDirectory();
    const providerLanes = join(directory, "provider-lanes");
    const interrupted = `.registry.json.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`;
    await mkdir(providerLanes);
    await writeFile(join(providerLanes, interrupted), '{"schemaVersion":1');
    const store = useStore(directory);

    expect(await store.init()).toEqual({ store: directory });
    expect(JSON.parse(
      await readFile(join(providerLanes, "registry.json"), "utf8")
    )).toEqual({ schemaVersion: 1, lanes: [] });
    expect(await readdir(providerLanes)).toEqual(["registry.json"]);
    expect(await store.init()).toEqual({ store: directory });
  });

  it("preserves an unrecognized registry temporary-file lookalike", async () => {
    const directory = await makeDirectory();
    const providerLanes = join(directory, "provider-lanes");
    const lookalike = `.registry.json.${process.pid}.not-a-uuid.tmp`;
    await mkdir(providerLanes);
    await writeFile(join(providerLanes, lookalike), "unrecognized\n");
    const store = useStore(directory);

    await expect(store.init()).rejects.toThrow("orphaned provider lane artifacts");
    expect(await readFile(join(providerLanes, lookalike), "utf8")).toBe(
      "unrecognized\n"
    );
  });

  it("composes unit add, set, get, list, and counts", async () => {
    const { store } = await initializedStore();

    expect(
      await store.units.add({
        id: "u1",
        track: "build",
        brief: "briefs/u1.md",
      })
    ).toMatchObject({ id: "u1", state: "pending" });
    expect(
      await store.units.add({ id: "=SUM(A1)", track: "+build" })
    ).toMatchObject({ id: "'=SUM(A1)", track: "'+build" });

    const updated = await store.units.set({
      id: "u1",
      state: "done",
      branch: "poteto/u1",
      pr: 184530,
      sha: "abc123",
    });
    expect(updated).toEqual({
      id: "u1",
      track: "build",
      state: "done",
      branch: "poteto/u1",
      pr: "184530",
      sha: "abc123",
      brief: "briefs/u1.md",
    });
    expect(await store.units.get("u1")).toEqual(updated);
    expect(
      await store.units.list({ state: "done", track: "build" })
    ).toEqual([updated]);
    expect(await store.units.counts()).toEqual({ done: 1, pending: 1 });
    await expect(
      store.units.add({ id: "u1", track: "build" })
    ).rejects.toThrow("unit u1 already exists");
    await expect(
      store.units.set({ id: "missing", state: "done" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("records, replaces, checks, and summarizes typed ledger verdicts", async () => {
    const { store } = await initializedStore();

    try {
      await store.ledger.check({ pr: 184530, sha: "abc123" });
      throw new Error("expected ledger check to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      if (error instanceof NotFoundError) {
        expect(error.output).toEqual({
          compact: "NOT-VERIFIED",
          json: {
            pr: "184530",
            sha: "abc123",
            verdict: "NOT-VERIFIED",
          },
        });
      }
    }
    expect(() => parseVerdict("looks-good")).toThrow("verdict must be");

    const recorded = await store.ledger.record({
      pr: 184530,
      sha: "abc123",
      verdict: "unit-test-verified",
      evidence: "reports/verify.md",
      verifier: "sol",
    });
    expect(await store.ledger.check({ pr: 184530, sha: "abc123" })).toEqual(
      recorded
    );
    expect(await store.ledger.summary()).toEqual({
      "unit-test-verified": 1,
    });

    await store.ledger.record({
      pr: 184530,
      sha: "abc123",
      verdict: "live-ui-verified",
      evidence: "reports/live.md",
    });
    expect(await store.ledger.summary()).toEqual({
      "live-ui-verified": 1,
    });
  });

  it("pushes, peeks, and atomically drains inbox pointers", async () => {
    const { directory, store } = await initializedStore();

    const first = await store.inbox.push({
      agent: "worker-1",
      unit: "u1",
      status: "done",
      report: "reports/u1.md",
    });
    expect(first.pointer).toMatchObject({ unit: "u1", status: "done" });
    expect(first.filename).toEndWith(".tsv");
    await store.inbox.push({
      agent: "worker-2",
      unit: "u2",
      status: "failed",
    });

    expect(await store.inbox.count()).toBe(2);
    expect(await store.inbox.peek()).toHaveLength(2);
    expect(await store.inbox.count()).toBe(2);
    expect(await store.inbox.drain()).toHaveLength(2);
    expect(await store.inbox.count()).toBe(0);
    expect(await readdir(join(directory, "inbox"))).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".inbox-drain-")
      )
    ).toEqual([]);
  });

  it("replaces a stale lock whose holder pid is dead", async () => {
    const { directory } = await initializedStore();
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    await writeFile(join(directory, ".orch.lock"), `${exited.pid}\n`);

    const stale: string[] = [];
    const recovered = useStore(directory, {
      onStaleLock: (holder) => stale.push(holder),
    });
    expect(
      await recovered.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    expect(stale).toEqual([String(exited.pid)]);
    await recovered.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("removes a stale legacy recovery PID file under the advisory guard", async () => {
    const { directory, store } = await initializedStore();
    await store.close();
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    await writeFile(join(directory, ".orch.lock"), `${exited.pid}\n`);
    await writeFile(join(directory, ".orch.lock.recovery"), `${exited.pid}\n`);

    const recovered = useStore(directory);
    expect(
      await recovered.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    await recovered.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
    expect(await readdir(directory)).not.toContain(".orch.lock.recovery");
  });

  it("releases the advisory recovery guard when its process is killed", async () => {
    const { directory, store } = await initializedStore();
    await store.close();
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    await writeFile(join(directory, ".orch.lock"), `${exited.pid}\n`);
    const guardPath = join(directory, ".orch.lock.recovery.sqlite");
    const holder = Bun.spawn([
      process.execPath,
      "-e",
      'import { Database } from "bun:sqlite"; const database = new Database(process.argv[1], { create: true }); database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); process.stdout.write("ready\\n"); await new Promise(() => {});',
      guardPath,
    ], { stdout: "pipe", stderr: "pipe" });
    const recovered = useStore(directory);
    try {
      const reader = holder.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
      await expect(
        recovered.units.add({ id: "u1", track: "build" })
      ).rejects.toThrow("store lock recovery is held");
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }

    expect(
      await recovered.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    await recovered.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("serializes simultaneous stale recovery-lock takeover into one durable lane claim", async () => {
    const { directory, store } = await initializedStore();
    await store.units.add({ id: "unit", track: "test" });
    const prompt = join(directory, "prompt.md");
    await writeFile(prompt, "review\n");
    await store.lanes.register({
      laneId: "review",
      unitId: "unit",
      parent: "codex",
      provider: "claude",
      model: "claude-opus-5",
      effort: "xhigh",
      mode: "read-only",
      promptPath: prompt,
      cwd: "/tmp",
    });
    await store.close();

    const exited = Bun.spawn(["true"]);
    await exited.exited;
    const command = [
      process.execPath,
      SCRIPT,
      "--store",
      directory,
      "--json",
      "lane",
      "tick",
    ];
    let durableAttemptId: string | null = null;
    for (let round = 0; round < 8; round += 1) {
      await writeFile(join(directory, ".orch.lock"), `${exited.pid}\n`);
      await writeFile(join(directory, ".orch.lock.recovery"), `${exited.pid}\n`);
      const barrier = join(directory, `tick-start-${round}`);
      const children = Array.from({ length: 32 }, () =>
        Bun.spawn(
          [
            "/bin/sh",
            "-c",
            'while [ ! -e "$1" ]; do :; done; shift; exec "$@"',
            "orch-tick",
            barrier,
            ...command,
          ],
          { stdout: "pipe", stderr: "pipe" }
        )
      );
      const results = children.map(async (child) => {
        const stdout = new Response(child.stdout).text();
        const stderr = new Response(child.stderr).text();
        return {
          code: await child.exited,
          stdout: await stdout,
          stderr: await stderr,
        };
      });
      await writeFile(barrier, "go\n");

      const settled = await Promise.all(results);
      const successful = settled.filter((result) => result.code === 0);
      expect(successful.length).toBeGreaterThan(0);
      const attemptIds = successful.flatMap((result) =>
        JSON.parse(result.stdout).plans.map(
          (plan: { readonly attemptId: string }) => plan.attemptId
        )
      );
      expect(attemptIds).toHaveLength(successful.length);
      expect(new Set(attemptIds).size).toBe(1);
      durableAttemptId ??= attemptIds[0] ?? null;
      expect(attemptIds[0]).toBe(durableAttemptId);

      const durable = JSON.parse(
        await readFile(join(directory, "provider-lanes", "registry.json"), "utf8")
      );
      expect(
        durable.lanes[0].attempts.filter(
          (attempt: { readonly kind: string }) => attempt.kind === "claimed"
        )
      ).toHaveLength(1);
      expect((await readdir(directory))).not.toContain(".orch.lock");
      expect((await readdir(directory))).not.toContain(".orch.lock.recovery");
      expect((await readdir(directory))).not.toContain(".orch.lock.recovery.owner");
      expect((await readdir(directory))).toContain(".orch.lock.recovery.sqlite");
    }
  }, 30_000);

  it("blocks a writer and steals the pid lock only with force", async () => {
    const { directory, store } = await initializedStore();
    await store.close();
    await writeFile(join(directory, ".orch.lock"), `${process.pid}\n`);
    await writeFile(join(directory, ".orch.lock.recovery"), `${process.pid}\n`);

    const blocked = useStore(directory);
    await expect(
      blocked.units.add({ id: "u1", track: "build" })
    ).rejects.toThrow(`store lock held by pid ${process.pid}`);

    const stolen: string[] = [];
    const forced = useStore(directory, {
      force: true,
      onLockStolen: (holder) => stolen.push(holder),
    });
    expect(
      await forced.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    expect(stolen).toEqual([String(process.pid)]);
    await forced.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("parks gates, stores standing orders, and renders status", async () => {
    const { directory, store } = await initializedStore();
    await store.units.add({ id: "u1", track: "build" });
    expect(
      await store.gates.park({
        id: "release",
        question: "Ship now?",
        options: "ship,wait",
        defaultAnswer: "wait",
      })
    ).toMatchObject({ kind: "open", id: "release" });
    expect(
      await store.standing.add({ line: "Never force push." })
    ).toEqual({ number: 1, line: "Never force push." });

    const first = await store.status.render();
    expect(first.changed).toBe("first render");
    expect(first.summary.openGateIds).toEqual(["release"]);
    expect(await readFile(join(directory, "status.md"), "utf8")).toContain(
      "| release | open | Ship now? |"
    );
    expect((await store.status.render()).changed).toBe("no derived changes");

    expect(
      await store.gates.resolve({ id: "release", answer: "ship" })
    ).toMatchObject({ kind: "resolved", answer: "ship" });
    expect((await store.status.render()).changed).toBe("open gates 1->0");
    expect(await store.gates.list()).toEqual([]);
    expect(await store.standing.show()).toEqual([
      { number: 1, line: "Never force push." },
    ]);
  });

  it("resolves the ordered Graphite frontier and validates an optional pin", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const output = `◯ main
◯ stack/merged
◯ stack/closed
◉ stack/open (current)
`;

    await withFakeGt({
      directory,
      output,
      operation: async () => {
        expect(await store.frontier.set({ repo: stack.repo })).toEqual({
          generation: 1,
          prs: [
            {
              pr: 10,
              branches: "stack/merged",
              sha: stack.mergedSha,
              state: "MERGED",
            },
            {
              pr: 13,
              branches: "stack/closed",
              sha: stack.closedSha,
              state: "CLOSED",
            },
            {
              pr: 11,
              branches: "stack/open",
              sha: stack.openSha,
              state: "OPEN",
            },
          ],
          lowestUnmerged: 11,
        });
        expect(
          (
            await store.frontier.set({
              repo: stack.repo,
              prs: [10, 13, 11],
            })
          ).generation
        ).toBe(2);
        expect((await store.frontier.show()).generation).toBe(2);
        await expect(
          store.frontier.set({
            repo: stack.repo,
            prs: [10, 11, 12],
          })
        ).rejects.toThrow(
          "frontier pin mismatch: missing from gt: 12; extra in gt: 13"
        );
        await expect(
          store.frontier.set({
            repo: stack.repo,
            prs: [13, 10, 11],
          })
        ).rejects.toThrow(
          "frontier pin mismatch: order differs: expected 13,10,11; gt 10,13,11"
        );
        await expect(
          store.frontier.set({
            repo: stack.repo,
            prs: [10, 10],
          })
        ).rejects.toThrow("--prs must not contain duplicates");
      },
    });
  });

  it("rejects unparseable Graphite output loudly", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGt({
      directory,
      output: "◯ main\nthis line is not Graphite output\n",
      operation: async () => {
        await expect(
          store.frontier.set({ repo: stack.repo })
        ).rejects.toThrow(
          'gt log short output has an unparseable line 2: "this line is not Graphite output"'
        );
      },
    });
  });

  it("rejects malformed TSV, verdict, frontier, and inbox data", async () => {
    const { directory, store } = await initializedStore();

    await writeFile(join(directory, "units.tsv"), "wrong\n");
    await expect(store.units.list()).rejects.toThrow(
      "units.tsv has an invalid header"
    );
    await writeFile(
      join(directory, "units.tsv"),
      "id\ttrack\tstate\tbranch\tpr\tsha\tbrief\nshort\trow\n"
    );
    await expect(store.units.list()).rejects.toThrow(
      "units.tsv has a malformed row"
    );

    await writeFile(
      join(directory, "ledger.tsv"),
      "pr\tsha\tverdict\tevidence\tverifier\tts\n1\tsha\tinvalid\treport\tme\tnow\n"
    );
    await expect(store.ledger.summary()).rejects.toThrow(
      "ledger.tsv has invalid verdict invalid"
    );

    await writeFile(join(directory, "frontier.json"), '{"generation":"1"}\n');
    await expect(store.frontier.show()).rejects.toThrow(
      "frontier.json has an invalid shape"
    );

    await writeFile(join(directory, "inbox", "bad.tsv"), "too\tshort\n");
    await expect(store.inbox.peek()).rejects.toThrow(
      "inbox pointer bad.tsv is malformed"
    );
  });

  it("treats a missing lane registry as corruption and preserves obligations", async () => {
    const { directory, store } = await initializedStore();
    await store.units.add({ id: "unit", track: "test" });
    const prompt = join(directory, "prompt.md");
    await writeFile(prompt, "review\n");
    await store.lanes.register({
      laneId: "review",
      unitId: "unit",
      parent: "codex",
      provider: "claude",
      model: "claude-opus-5",
      effort: "xhigh",
      mode: "read-only",
      promptPath: prompt,
      cwd: "/tmp",
    });
    const registryPath = join(directory, "provider-lanes", "registry.json");
    await rm(registryPath);

    await expect(store.lanes.check("unit")).rejects.toThrow(
      "provider lane registry is missing"
    );
    await expect(
      store.units.set({ id: "unit", state: "done" })
    ).rejects.toThrow("provider lane registry is missing");
    expect((await store.units.get("unit")).state).toBe("pending");
    await expect(store.init()).rejects.toThrow(
      "provider lane registry is missing after initialization"
    );
    await rm(join(directory, ".orch.lane-registry.initialized"));
    await expect(store.init()).rejects.toThrow("orphaned provider lane artifacts");
    expect(await readdir(join(directory, "provider-lanes", "review"))).toContain(
      "prompt.md"
    );
  });

  it("identifies a pre-registry store as uninitialized and repairs it with init", async () => {
    const { directory, store } = await initializedStore();
    await store.units.add({ id: "unit", track: "test" });
    await rm(join(directory, "provider-lanes", "registry.json"));
    await rm(join(directory, ".orch.lane-registry.initialized"));

    await expect(store.units.set({ id: "unit", state: "done" })).rejects.toThrow(
      "run orch init"
    );

    await store.init();
    await store.init();
    expect(await store.units.set({ id: "unit", state: "done" })).toMatchObject({
      state: "done",
    });
  });

  it("does not recreate a deleted provider-lanes subtree after initialization", async () => {
    const { directory, store } = await initializedStore();
    await store.units.add({ id: "unit", track: "test" });
    const prompt = join(directory, "prompt.md");
    await writeFile(prompt, "review\n");
    await store.lanes.register({
      laneId: "review",
      unitId: "unit",
      parent: "codex",
      provider: "claude",
      model: "claude-opus-5",
      effort: "xhigh",
      mode: "read-only",
      promptPath: prompt,
      cwd: "/tmp",
    });
    await rm(join(directory, "provider-lanes"), { recursive: true });

    await expect(store.lanes.check("unit")).rejects.toThrow(
      "provider lane registry is missing"
    );
    await expect(store.init()).rejects.toThrow(
      "provider lane registry is missing after initialization"
    );
    await expect(
      store.units.set({ id: "unit", state: "done" })
    ).rejects.toThrow("provider lane registry is missing");
    expect((await store.units.get("unit")).state).toBe("pending");
    expect(await readdir(directory)).toContain(".orch.lane-registry.initialized");
    await expect(readdir(join(directory, "provider-lanes"))).rejects.toThrow();
  });

  it("rejects operations after close", async () => {
    const { store } = await initializedStore();
    await store.close();
    await expect(store.units.list()).rejects.toThrow("store is closed");
    await expect(store.status.render()).rejects.toBeInstanceOf(UserError);
  });
});

describe("orch CLI", () => {
  it("prints commander help and rejects invalid parsing with exit 1", async () => {
    const help = runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Commands:");
    expect(help.stdout).toContain("unit");
    expect(help.stdout).toContain("ledger");

    const frontierHelp = runCli(["frontier", "set", "--help"]);
    expect(frontierHelp.code).toBe(0);
    expect(frontierHelp.stdout).toContain("--repo <dir>");
    expect(frontierHelp.stdout).toContain("--prs <n,...>");

    const directory = await makeDirectory();
    const invalid = runCli(["--store", directory, "unit", "add", "u1"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("required option '--track <track>'");
  });

  it("accepts ORCH_STORE and emits complete JSON", async () => {
    const directory = await makeDirectory();
    const env = { ...process.env, ORCH_STORE: directory };
    expect(runCli(["init"], env).code).toBe(0);

    const added = runCli(
      ["unit", "add", "u1", "--track", "build", "--json"],
      env
    );
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({
      id: "u1",
      track: "build",
      state: "pending",
      branch: "",
      pr: "",
      sha: "",
      brief: "",
    });
  });

  it("drives every lane command and reports blocking ids in plain and JSON modes", async () => {
    const directory = await makeDirectory();
    const prompt = join(directory, "prompt.md");
    await writeFile(prompt, "review this\n");
    expect(runCli(["--store", directory, "init"]).code).toBe(0);
    expect(runCli([
      "--store", directory,
      "unit", "add", "unit",
      "--track", "test",
    ]).code).toBe(0);

    expect(runCli([
      "--store", directory,
      "lane", "check",
      "--unit", "unit",
    ])).toEqual({ code: 0, stdout: "READY\n", stderr: "" });

    const registered = runCli([
      "--store", directory,
      "lane", "register", "review",
      "--unit", "unit",
      "--parent", "codex",
      "--provider", "claude",
      "--model", "claude-opus-5",
      "--effort", "xhigh",
      "--mode", "read-only",
      "--prompt", prompt,
      "--cwd", "/tmp",
    ]);
    expect(registered).toMatchObject({ code: 0, stdout: "review\tregistered\n", stderr: "" });

    const ticked = runCli(["--store", directory, "--json", "lane", "tick"]);
    expect(ticked.code).toBe(0);
    const plans = JSON.parse(ticked.stdout).plans;
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan.command).toBe(join(import.meta.dir, "..", "runner", "pstack-runner"));
    expect(parseRunnerArgs(plan.argv)).toMatchObject({
      parent: "codex",
      provider: "claude",
      model: "claude-opus-5",
      effort: "xhigh",
      mode: "read-only",
      promptPath: join(directory, "provider-lanes", "review", "prompt.md"),
      cwd: "/tmp",
      outputPath: plan.outputPath,
      receiptPath: plan.receiptPath,
      managedAttempt: {
        laneId: "review",
        attemptId: plan.attemptId,
      },
    });

    const blocked = runCli([
      "--store", directory,
      "lane", "check",
      "--unit", "unit",
    ]);
    expect(blocked).toEqual({
      code: 3,
      stdout: "",
      stderr: "BLOCKED\treview\n",
    });
    const blockedJson = runCli([
      "--store", directory,
      "--json",
      "lane", "check",
      "--unit", "unit",
    ]);
    expect(blockedJson.code).toBe(3);
    expect(blockedJson.stderr).toBe("");
    expect(JSON.parse(blockedJson.stdout)).toEqual({
      unitId: "unit",
      ready: false,
      blockingLaneIds: ["review"],
    });

    const released = runCli([
      "--store", directory,
      "lane", "release", "review",
      "--attempt", plan.attemptId,
      "--reason", "retained pid 12 is dead",
    ]);
    expect(released).toMatchObject({ code: 0, stdout: "review\tinterrupted\n", stderr: "" });

    const retried = runCli([
      "--store", directory,
      "--json",
      "lane", "retry", "review",
    ]);
    expect(retried.code).toBe(0);
    const retryPlan = JSON.parse(retried.stdout);
    expect(retryPlan.laneId).toBe("review");
    expect(retryPlan.attemptId).not.toBe(plan.attemptId);
    expect(retryPlan.outputPath).not.toBe(plan.outputPath);

    const unknown = runCli([
      "--store", directory,
      "lane", "check",
      "--unit", "missing",
    ]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unit missing not found");
  });

  it("reports a stalled claimed lane in plain and JSON tick output", async () => {
    const directory = await makeDirectory();
    const prompt = join(directory, "prompt.md");
    const cwd = join(directory, "lane-cwd");
    await writeFile(prompt, "review this\n");
    await mkdir(cwd);
    expect(runCli(["--store", directory, "init"]).code).toBe(0);
    expect(runCli([
      "--store", directory,
      "unit", "add", "unit",
      "--track", "test",
    ]).code).toBe(0);
    expect(runCli([
      "--store", directory,
      "lane", "register", "review",
      "--unit", "unit",
      "--parent", "codex",
      "--provider", "claude",
      "--model", "claude-opus-5",
      "--effort", "xhigh",
      "--mode", "read-only",
      "--prompt", prompt,
      "--cwd", cwd,
    ]).code).toBe(0);
    expect(JSON.parse(runCli([
      "--store", directory,
      "--json",
      "lane", "tick",
    ]).stdout).plans).toHaveLength(1);
    await rm(cwd, { recursive: true });

    const plain = runCli(["--store", directory, "lane", "tick"]);
    expect(plain).toEqual({
      code: 0,
      stdout: "(no launch)\n",
      stderr: "STALLED\treview\tlane review working directory is missing or is not a directory\n",
    });

    const json = runCli(["--store", directory, "--json", "lane", "tick"]);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      plans: [],
      stalledLanes: [{
        laneId: "review",
        reason: "lane review working directory is missing or is not a directory",
      }],
    });
  });

  it("reports terminal and partial-artifact claim barriers in plain and JSON tick output", async () => {
    const directory = await makeDirectory();
    const prompt = join(directory, "prompt.md");
    await writeFile(prompt, "review this\n");
    const store = useStore(directory);
    await store.init();
    for (const unit of ["terminal-unit", "partial-unit", "claude-next", "codex-next"]) {
      await store.units.add({ id: unit, track: "test" });
    }
    await store.lanes.register({
      laneId: "terminal-review",
      unitId: "terminal-unit",
      parent: "codex",
      provider: "claude",
      model: "claude-opus-5",
      effort: "xhigh",
      mode: "read-only",
      promptPath: prompt,
      cwd: "/tmp",
    });
    await store.lanes.register({
      laneId: "partial-review",
      unitId: "partial-unit",
      parent: "claude",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
      mode: "read-only",
      promptPath: prompt,
      cwd: "/tmp",
    });
    const initial = (await store.lanes.tick()).plans;
    expect(initial).toHaveLength(2);
    const partial = initial.find((plan) => plan.laneId === "partial-review");
    if (partial === undefined) throw new Error("missing partial plan");
    await writeFile(partial.outputPath, "reserved");
    await store.units.set({ id: "terminal-unit", state: "abandoned" });
    await store.lanes.register({
      laneId: "claude-next",
      unitId: "claude-next",
      parent: "codex",
      provider: "claude",
      model: "claude-opus-5",
      effort: "xhigh",
      mode: "read-only",
      promptPath: prompt,
      cwd: "/tmp",
    });
    await store.lanes.register({
      laneId: "codex-next",
      unitId: "codex-next",
      parent: "claude",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
      mode: "read-only",
      promptPath: prompt,
      cwd: "/tmp",
    });
    await store.close();

    const plain = runCli(["--store", directory, "lane", "tick"]);
    expect(plain).toEqual({
      code: 0,
      stdout: "(no launch)\n",
      stderr: [
        "STALLED\tterminal-review\tlane terminal-review is claimed without launcher artifacts on terminal unit terminal-unit; provider claude remains occupied",
        "STALLED\tpartial-review\tlane partial-review claim has an output artifact without a receipt artifact; provider codex remains occupied",
        "",
      ].join("\n"),
    });

    const json = runCli(["--store", directory, "--json", "lane", "tick"]);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      plans: [],
      stalledLanes: [
        {
          laneId: "terminal-review",
          reason: "lane terminal-review is claimed without launcher artifacts on terminal unit terminal-unit; provider claude remains occupied",
        },
        {
          laneId: "partial-review",
          reason: "lane partial-review claim has an output artifact without a receipt artifact; provider codex remains occupied",
        },
      ],
    });

    const registry = JSON.parse(
      await readFile(join(directory, "provider-lanes", "registry.json"), "utf8")
    );
    expect(registry.lanes.find(
      (lane: { readonly spec: { readonly laneId: string } }) =>
        lane.spec.laneId === "claude-next"
    ).attempts.at(-1).kind).toBe("registered");
    expect(registry.lanes.find(
      (lane: { readonly spec: { readonly laneId: string } }) =>
        lane.spec.laneId === "codex-next"
    ).attempts.at(-1).kind).toBe("registered");
  });

  it("maps user and not-found outcomes to the preserved exit codes", async () => {
    const directory = await makeDirectory();
    expect(runCli(["--store", directory, "init"]).code).toBe(0);

    const missingRepo = runCli([
      "--store",
      directory,
      "frontier",
      "set",
    ]);
    expect(missingRepo.code).toBe(1);
    expect(missingRepo.stderr).toContain(
      "set --repo <dir> or ORCH_REPO"
    );

    const userError = runCli([
      "--store",
      directory,
      "unit",
      "add",
      "",
      "--track",
      "build",
    ]);
    expect(userError.code).toBe(1);
    expect(userError.stderr).toContain("unit id must not be empty");

    const missingUnit = runCli([
      "--store",
      directory,
      "unit",
      "get",
      "missing",
    ]);
    expect(missingUnit.code).toBe(2);
    expect(missingUnit.stderr).toContain("unit missing not found");

    const missingLedger = runCli([
      "--store",
      directory,
      "--json",
      "ledger",
      "check",
      "184530",
      "abc123",
    ]);
    expect(missingLedger.code).toBe(2);
    expect(JSON.parse(missingLedger.stdout)).toEqual({
      pr: "184530",
      sha: "abc123",
      verdict: "NOT-VERIFIED",
    });
    expect(missingLedger.stderr).toBe("");
  });
});
