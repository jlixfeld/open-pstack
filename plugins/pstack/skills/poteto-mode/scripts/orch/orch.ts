#!/usr/bin/env bun

import { ensureDependenciesInstalled } from "../bootstrap.ts";
import {
  NotFoundError,
  UsageError,
  openStore,
  parseVerdict,
  type Counts,
  type Frontier,
  type InboxPointer,
  type OpenGate,
  type StandingLine,
  type StatusReport,
  type Store,
  type Unit,
  type Verdict,
} from "./store.ts";
import {
  ACCESS_MODES,
  EFFORTS,
  PARENTS,
  PROVIDERS,
} from "../runner/types.ts";
import type { LaneCheck } from "./lanes.ts";

ensureDependenciesInstalled();
const {
  Command: CommanderCommand,
  CommanderError,
  InvalidArgumentError,
  Option,
} = await import("commander");
type Command = InstanceType<typeof CommanderCommand>;

const DISPLAY_LIMIT = 4;

interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

interface GlobalOptions {
  readonly store?: string;
  readonly json: boolean;
  readonly force: boolean;
}

interface UnitAddOptions {
  readonly track: string;
  readonly brief?: string;
}

interface UnitSetOptions {
  readonly state: string;
  readonly branch?: string;
  readonly pr?: number;
  readonly sha?: string;
}

interface UnitListOptions {
  readonly state?: string;
  readonly track?: string;
}

interface LedgerRecordOptions {
  readonly evidence: string;
  readonly verifier?: string;
}

interface InboxPushOptions {
  readonly report?: string;
}

interface InboxDrainOptions {
  readonly peek: boolean;
}

interface GateParkOptions {
  readonly question: string;
  readonly options: string;
  readonly default: string;
}

interface GateResolveOptions {
  readonly answer: string;
}

interface LaneRegisterOptions {
  readonly unit: string;
  readonly parent: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly mode: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly intervalSeconds?: number;
  readonly timeout?: number;
}

interface LaneReleaseOptions {
  readonly attempt: string;
  readonly reason: string;
}

class LaneBlockedError extends Error {
  constructor(readonly check: LaneCheck) {
    super(`unit ${check.unitId} is blocked by ${check.blockingLaneIds.join(", ")}`);
  }
}

interface FrontierSetOptions {
  readonly repo?: string;
  readonly prs?: readonly number[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function laneChoice<T extends string>(
  value: string,
  choices: readonly T[],
  label: string
): T {
  const choice = choices.find((candidate) => candidate === value);
  if (choice === undefined) {
    throw new UsageError(`${label} must be one of: ${choices.join(", ")}`);
  }
  return choice;
}

function prList(value: string): readonly number[] {
  const parts = value.split(",");
  if (parts.some((part) => part.length === 0)) {
    throw new InvalidArgumentError("requires a comma-separated PR list");
  }
  return parts.map(positiveInteger);
}

function countLine(value: Counts): string {
  const entries = Object.entries(value);
  return entries.length === 0
    ? "none"
    : entries.map(([name, count]) => `${name}=${count}`).join(", ");
}

function unitLine(unit: Unit): string {
  return [
    unit.id,
    unit.track,
    unit.state,
    unit.branch,
    unit.pr,
    unit.sha,
    unit.brief,
  ].join("\t");
}

function pointerLine(pointer: InboxPointer): string {
  return [
    pointer.ts,
    pointer.agent,
    pointer.unit,
    pointer.status,
    pointer.report,
  ].join("\t");
}

function gateLine(gate: OpenGate): string {
  return [
    gate.id,
    gate.question,
    gate.options,
    gate.defaultAnswer,
  ].join("\t");
}

function compactRows<T>(
  rows: readonly T[],
  format: (row: T) => string,
  empty: string,
  limit: number | null = DISPLAY_LIMIT
): string {
  if (rows.length === 0) {
    return empty;
  }
  const visible = limit === null ? rows : rows.slice(0, limit);
  const lines = visible.map(format);
  if (limit !== null && rows.length > limit) {
    lines.push(`... ${rows.length - limit} more; use --json`);
  }
  return lines.join("\n");
}

function frontierLine(value: Frontier): string {
  const prs =
    value.prs.length === 0
      ? "none"
      : value.prs
          .map(
            (row) =>
              `${row.branches}#${row.pr}@${row.sha}:${row.state}`
          )
          .join(",");
  return `generation=${value.generation} prs=${prs} lowest-unmerged=${value.lowestUnmerged ?? "none"}`;
}

function statusLines(report: StatusReport): string {
  const visible = report.summary.openGateIds.slice(0, DISPLAY_LIMIT);
  const more =
    report.summary.openGateIds.length > DISPLAY_LIMIT
      ? `,+${report.summary.openGateIds.length - DISPLAY_LIMIT} more`
      : "";
  return [
    `counts: units=${report.units.length}; states=${countLine(report.summary.unitStates)}; ledger=${countLine(report.summary.ledgerVerdicts)}`,
    `changed: ${report.changed}`,
    `gates open: ${report.summary.openGateIds.length}${
      visible.length > 0 ? `; ids=${visible.join(",")}${more}` : ""
    }`,
  ].join("\n");
}

function emit<T>(
  io: Io,
  json: boolean,
  value: T,
  compact: (result: T) => string,
  jsonValue: (result: T) => unknown = (result) => result
): void {
  const rendered = json
    ? JSON.stringify(jsonValue(value), null, 2)
    : compact(value);
  io.stdout(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}

function storeDirectory(program: Command): string {
  const value = program.opts<GlobalOptions>().store;
  if (value === undefined || value.trim().length === 0) {
    throw new UsageError("set --store <dir> or ORCH_STORE");
  }
  return value;
}

function frontierRepo(options: FrontierSetOptions): string {
  const value = options.repo;
  if (value === undefined || value.trim().length === 0) {
    throw new UsageError("set --repo <dir> or ORCH_REPO");
  }
  return value;
}

async function runStore<T>(
  program: Command,
  io: Io,
  operation: (store: Store) => Promise<T>,
  compact: (result: T) => string,
  jsonValue?: (result: T) => unknown
): Promise<void> {
  const options = program.opts<GlobalOptions>();
  const store = openStore(storeDirectory(program), {
    force: options.force,
    onLockStolen: (holder) =>
      io.stderr(`stealing store lock held by pid ${holder}\n`),
    onStaleLock: (holder) =>
      io.stderr(`replacing stale store lock (pid ${holder} is dead)\n`),
  });
  try {
    const result = await operation(store);
    emit(io, options.json, result, compact, jsonValue);
  } finally {
    await store.close();
  }
}

function leaf(parent: Command, name: string, description: string): Command {
  return parent
    .command(name)
    .description(description)
    .allowExcessArguments(false);
}

function requireSubcommand(program: Command): never {
  storeDirectory(program);
  throw new UsageError("a valid command is required");
}

function createProgram(io: Io): Command {
  const program = new CommanderCommand("orch")
    .description("Plain-file orchestrate bookkeeping")
    .usage("[--store <dir>] [--json] [--force] <command>")
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride()
    .showHelpAfterError()
    .allowExcessArguments(false)
    .addOption(
      new Option("--store <dir>", "store directory (or ORCH_STORE)").env(
        "ORCH_STORE"
      )
    )
    .option("--json", "print complete rows as JSON", false)
    .option("--force", "steal an existing store lock", false);

  leaf(program, "init", "initialize the store").action(() =>
    runStore(
      program,
      io,
      (store) => store.init(),
      (result) => `initialized ${result.store}`
    )
  );

  const unit = program
    .command("unit")
    .description("manage work units")
    .action(() => requireSubcommand(program));
  leaf(unit, "add <id>", "add a unit")
    .requiredOption("--track <track>", "unit track")
    .option("--brief <path>", "brief path")
    .action((id: string, options: UnitAddOptions) =>
      runStore(
        program,
        io,
        (store) =>
          store.units.add({
            id,
            track: options.track,
            brief: options.brief,
          }),
        unitLine
      )
    );

  const lane = program
    .command("lane")
    .description("manage mandatory provider lanes")
    .action(() => requireSubcommand(program));
  leaf(lane, "register <lane-id>", "register an immutable provider lane")
    .requiredOption("--unit <unit-id>", "dependent unit")
    .requiredOption("--parent <parent>", "parent harness")
    .requiredOption("--provider <provider>", "assigned provider")
    .requiredOption("--model <model>", "assigned model")
    .requiredOption("--effort <effort>", "assigned effort")
    .requiredOption("--mode <mode>", "access mode")
    .requiredOption("--prompt <path>", "prompt file")
    .requiredOption("--cwd <path>", "working directory")
    .option(
      "--interval-seconds <n>",
      "pause retry interval (minimum 1800)",
      positiveInteger
    )
    .option("--timeout <seconds>", "explicit runner timeout", positiveInteger)
    .action((laneId: string, options: LaneRegisterOptions) =>
      runStore(
        program,
        io,
        (store) => store.lanes.register({
          laneId,
          unitId: options.unit,
          parent: laneChoice(options.parent, PARENTS, "parent"),
          provider: laneChoice(options.provider, PROVIDERS, "provider"),
          model: options.model,
          effort: laneChoice(options.effort, EFFORTS, "effort"),
          mode: laneChoice(options.mode, ACCESS_MODES, "mode"),
          promptPath: options.prompt,
          cwd: options.cwd,
          intervalSeconds: options.intervalSeconds,
          timeoutSeconds: options.timeout,
        }),
        (result) => `${result.spec.laneId}\tregistered`
      )
    );
  leaf(lane, "tick", "reconcile and claim due provider lanes").action(() =>
    runStore(
      program,
      io,
      (store) => store.lanes.tick(),
      (plans) => plans.map((plan) => `${plan.laneId}\t${plan.attemptId}`).join("\n") || "(no launch)",
      (plans) => ({ plans })
    )
  );
  leaf(lane, "check", "check mandatory lanes for a unit")
    .requiredOption("--unit <unit-id>", "dependent unit")
    .action((options: { readonly unit: string }) =>
      runStore(
        program,
        io,
        async (store) => {
          const result = await store.lanes.check(options.unit);
          if (!result.ready) throw new LaneBlockedError(result);
          return result;
        },
        () => "READY",
        (result) => result
      )
    );
  leaf(lane, "retry <lane-id>", "explicitly retry an ordinary failed lane")
    .action((laneId: string) =>
      runStore(
        program,
        io,
        (store) => store.lanes.retry(laneId),
        (plan) => `${plan.laneId}\t${plan.attemptId}`,
        (plan) => plan
      )
    );
  leaf(lane, "release <lane-id>", "release a dead claimed attempt")
    .requiredOption("--attempt <attempt-id>", "claimed attempt id")
    .requiredOption("--reason <text>", "authoritative dead-process evidence")
    .action((laneId: string, options: LaneReleaseOptions) =>
      runStore(
        program,
        io,
        (store) => store.lanes.release({
          laneId,
          attemptId: options.attempt,
          reason: options.reason,
        }),
        (result) => `${result.spec.laneId}\tinterrupted`
      )
    );
  leaf(unit, "set <id>", "update a unit")
    .requiredOption("--state <state>", "unit state")
    .option("--branch <branch>", "branch name")
    .option("--pr <number>", "pull request number", positiveInteger)
    .option("--sha <sha>", "commit SHA")
    .action((id: string, options: UnitSetOptions) =>
      runStore(
        program,
        io,
        (store) =>
          store.units.set({
            id,
            state: options.state,
            branch: options.branch,
            pr: options.pr,
            sha: options.sha,
          }),
        unitLine
      )
    );
  leaf(unit, "get <id>", "get a unit").action((id: string) =>
    runStore(program, io, (store) => store.units.get(id), unitLine)
  );
  leaf(unit, "list", "list units")
    .option("--state <state>", "filter by state")
    .option("--track <track>", "filter by track")
    .action((options: UnitListOptions) =>
      runStore(
        program,
        io,
        (store) => store.units.list(options),
        (rows) => compactRows(rows, unitLine, "(no units)")
      )
    );
  leaf(unit, "counts", "count units by state").action(() =>
    runStore(program, io, (store) => store.units.counts(), countLine)
  );

  const ledger = program
    .command("ledger")
    .description("manage verification records")
    .action(() => requireSubcommand(program));
  leaf(ledger, "record", "record a verification verdict")
    .argument("<pr>", "pull request number", positiveInteger)
    .argument("<sha>", "commit SHA")
    .argument("<verdict>", "verification verdict", parseVerdict)
    .requiredOption("--evidence <path>", "evidence path")
    .option("--verifier <name>", "verifier name")
    .action(
      (
        pr: number,
        sha: string,
        verdict: Verdict,
        options: LedgerRecordOptions
      ) =>
        runStore(
          program,
          io,
          (store) =>
            store.ledger.record({
              pr,
              sha,
              verdict,
              evidence: options.evidence,
              verifier: options.verifier,
            }),
          (row) => `${row.pr}\t${row.sha}\t${row.verdict}`
        )
    );
  leaf(ledger, "check", "check a verification verdict")
    .argument("<pr>", "pull request number", positiveInteger)
    .argument("<sha>", "commit SHA")
    .action((pr: number, sha: string) =>
      runStore(
        program,
        io,
        (store) => store.ledger.check({ pr, sha }),
        (row) => row.verdict
      )
    );
  leaf(ledger, "summary", "count verification verdicts").action(() =>
    runStore(program, io, (store) => store.ledger.summary(), countLine)
  );

  const inbox = program
    .command("inbox")
    .description("manage agent pointers")
    .action(() => requireSubcommand(program));
  leaf(inbox, "push <agent> <unit> <status>", "push an inbox pointer")
    .option("--report <path>", "report path")
    .action(
      (
        agent: string,
        unitId: string,
        status: string,
        options: InboxPushOptions
      ) =>
        runStore(
          program,
          io,
          (store) =>
            store.inbox.push({
              agent,
              unit: unitId,
              status,
              report: options.report,
            }),
          (result) =>
            `${result.pointer.unit}\t${result.pointer.status}\t${result.filename}`,
          (result) => result.pointer
        )
    );
  leaf(inbox, "drain", "drain inbox pointers")
    .option("--peek", "read without draining", false)
    .action((options: InboxDrainOptions) =>
      runStore(
        program,
        io,
        (store) =>
          options.peek ? store.inbox.peek() : store.inbox.drain(),
        (rows) => compactRows(rows, pointerLine, "(empty)", null)
      )
    );
  leaf(inbox, "count", "count inbox pointers").action(() =>
    runStore(
      program,
      io,
      (store) => store.inbox.count(),
      String,
      (count) => ({ count })
    )
  );

  const gate = program
    .command("gate")
    .description("manage decision gates")
    .action(() => requireSubcommand(program));
  leaf(gate, "park <id>", "park a decision gate")
    .requiredOption("--question <question>", "gate question")
    .requiredOption("--options <options>", "gate options")
    .requiredOption("--default <answer>", "default answer")
    .action((id: string, options: GateParkOptions) =>
      runStore(
        program,
        io,
        (store) =>
          store.gates.park({
            id,
            question: options.question,
            options: options.options,
            defaultAnswer: options.default,
          }),
        (result) => `${result.id}\topen`
      )
    );
  leaf(gate, "list", "list open decision gates").action(() =>
    runStore(
      program,
      io,
      (store) => store.gates.list(),
      (rows) => compactRows(rows, gateLine, "(no open gates)")
    )
  );
  leaf(gate, "resolve <id>", "resolve a decision gate")
    .requiredOption("--answer <answer>", "chosen answer")
    .action((id: string, options: GateResolveOptions) =>
      runStore(
        program,
        io,
        (store) => store.gates.resolve({ id, answer: options.answer }),
        (result) => `${result.id}\tresolved\t${result.answer}`
      )
    );

  const frontier = program
    .command("frontier")
    .description("manage the Graphite stack frontier")
    .action(() => requireSubcommand(program));
  leaf(frontier, "set", "discover the Graphite stack and set the frontier")
    .addOption(
      new Option(
        "--repo <dir>",
        "repository directory (or ORCH_REPO)"
      ).env("ORCH_REPO")
    )
    .option(
      "--prs <n,...>",
      "optional expected pull request order pin",
      prList
    )
    .action((options: FrontierSetOptions) =>
      runStore(
        program,
        io,
        (store) =>
          store.frontier.set({
            repo: frontierRepo(options),
            prs: options.prs,
          }),
        frontierLine
      )
    );
  leaf(frontier, "show", "show the frontier").action(() =>
    runStore(program, io, (store) => store.frontier.show(), frontierLine)
  );

  leaf(program, "status", "render status.md and print a summary").action(() =>
    runStore(program, io, (store) => store.status.render(), statusLines)
  );

  const standing = program
    .command("standing")
    .description("manage standing orders")
    .action(() => requireSubcommand(program));
  leaf(standing, "show", "show standing orders").action(() =>
    runStore(
      program,
      io,
      (store) => store.standing.show(),
      (rows) =>
        compactRows(
          rows,
          (item: StandingLine) => `${item.number}. ${item.line}`,
          "(no standing orders)"
        )
    )
  );
  leaf(standing, "add <line>", "add a standing order").action((line: string) =>
    runStore(
      program,
      io,
      (store) => store.standing.add({ line }),
      (item) => `${item.number}. ${item.line}`
    )
  );

  program.action(() => requireSubcommand(program));
  return program;
}

function handleError(error: unknown, program: Command, io: Io): number {
  if (error instanceof LaneBlockedError) {
    if (program.opts<GlobalOptions>().json) {
      io.stdout(`${JSON.stringify(error.check)}\n`);
    } else {
      io.stderr(`BLOCKED\t${error.check.blockingLaneIds.join(",")}\n`);
    }
    return 3;
  }
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? 0 : 1;
  }
  const json = program.opts<GlobalOptions>().json;
  if (error instanceof NotFoundError) {
    const output = error.output;
    if (output === undefined) {
      io.stderr(`error: ${error.message}\n`);
    } else {
      emit(io, json, output.json, () => output.compact);
    }
    return 2;
  }
  io.stderr(`error: ${message(error)}\n`);
  if (error instanceof UsageError) {
    io.stderr(program.helpInformation());
  }
  return 1;
}

export async function main(
  argv: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  }
): Promise<number> {
  const program = createProgram(io);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    return handleError(error, program, io);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
