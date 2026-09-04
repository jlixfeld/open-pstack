import { parseArgs as parseNodeArgs } from "node:util";
import { resolvedOptions, runLane } from "./run.ts";
import {
  ACCESS_MODES,
  EFFORTS,
  MODEL_EFFORTS,
  PARENTS,
  PROVIDERS,
  type AccessMode,
  type Effort,
  type Parent,
  type Provider,
  type RunnerOptions,
  UsageError,
} from "./types.ts";

const HELP = `Usage: pstack-runner --parent <claude|codex> --provider <claude|codex|grok> \\
  --model <slug> --effort <level> --mode <read-only|isolated-write> \\
  --prompt <file> --cwd <dir> --output <file> --receipt <file> [--timeout <seconds>] \\
  [--lane-id <id> --attempt-id <id> --lane-fingerprint <sha256> --prompt-sha256 <sha256>]

Runs exactly one external model lane. Same-provider calls are rejected; use the
parent harness's native subagent primitive for those lanes. Output and receipt
paths must not already exist. There is no implicit timeout. Pass --timeout only
when the user or task supplies a real deadline; it is one end-to-end launcher
deadline shared by setup, preflight, and model execution.
All paths are normalized to absolute paths before managed identity is checked.
`;

interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const defaultIo: Io = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function oneOf<T extends string>(
  name: string,
  value: string | undefined,
  choices: readonly T[]
): T {
  if (value === undefined || !choices.includes(value as T)) {
    throw new UsageError(`${name} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new UsageError(`${name} is required`);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sha256(name: string, value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new UsageError(`${name} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function managedAttempt(values: {
  readonly laneId: unknown;
  readonly attemptId: unknown;
  readonly laneFingerprint: unknown;
  readonly promptSha256: unknown;
}): RunnerOptions["managedAttempt"] {
  const entries = [
    ["lane-id", stringValue(values.laneId)],
    ["attempt-id", stringValue(values.attemptId)],
    ["lane-fingerprint", stringValue(values.laneFingerprint)],
    ["prompt-sha256", stringValue(values.promptSha256)],
  ] as const;
  const supplied = entries.filter(([, value]) => value !== undefined);
  if (supplied.length === 0) return null;
  if (supplied.length !== entries.length) {
    throw new UsageError(
      "lane-id, attempt-id, lane-fingerprint, and prompt-sha256 must be provided together"
    );
  }
  return {
    laneId: required("lane-id", entries[0][1]),
    attemptId: required("attempt-id", entries[1][1]),
    laneFingerprint: sha256("lane-fingerprint", required("lane-fingerprint", entries[2][1])),
    promptSha256: sha256("prompt-sha256", required("prompt-sha256", entries[3][1])),
  };
}

export function parseArgs(argv: readonly string[]): RunnerOptions | null {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        parent: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        mode: { type: "string" },
        prompt: { type: "string" },
        cwd: { type: "string" },
        output: { type: "string" },
        receipt: { type: "string" },
        timeout: { type: "string" },
        "lane-id": { type: "string" },
        "attempt-id": { type: "string" },
        "lane-fingerprint": { type: "string" },
        "prompt-sha256": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help) return null;
  const mode = oneOf(
    "mode",
    stringValue(parsed.values.mode),
    ACCESS_MODES
  ) as AccessMode;
  const timeoutValue = stringValue(parsed.values.timeout);
  const timeoutSeconds = timeoutValue === undefined ? null : Number(timeoutValue);
  if (
    timeoutSeconds !== null &&
    (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    throw new UsageError("timeout must be a number greater than zero");
  }
  const provider = oneOf("provider", stringValue(parsed.values.provider), PROVIDERS) as Provider;
  const model = required("model", stringValue(parsed.values.model));
  const effort = oneOf("effort", stringValue(parsed.values.effort), EFFORTS) as Effort;
  const selectable = MODEL_EFFORTS[`${provider}:${model}` as keyof typeof MODEL_EFFORTS];
  if (selectable === undefined || !(selectable as readonly Effort[]).includes(effort)) {
    throw new UsageError(`unsupported model or effort: ${provider}:${model}@${effort}`);
  }
  return resolvedOptions({
    parent: oneOf("parent", stringValue(parsed.values.parent), PARENTS) as Parent,
    provider,
    model,
    effort,
    mode,
    promptPath: required("prompt", stringValue(parsed.values.prompt)),
    cwd: required("cwd", stringValue(parsed.values.cwd)),
    outputPath: required("output", stringValue(parsed.values.output)),
    receiptPath: required("receipt", stringValue(parsed.values.receipt)),
    timeoutMs: timeoutSeconds === null ? null : timeoutSeconds * 1_000,
    managedAttempt: managedAttempt({
      laneId: parsed.values["lane-id"],
      attemptId: parsed.values["attempt-id"],
      laneFingerprint: parsed.values["lane-fingerprint"],
      promptSha256: parsed.values["prompt-sha256"],
    }),
  });
}

export async function main(
  argv: readonly string[],
  startedAt: number = Date.now(),
  io: Io = defaultIo
): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options === null) {
      io.stdout(HELP);
      return 0;
    }
    const result = await runLane(options, startedAt);
    const rendered = `${JSON.stringify(result.receipt)}\n`;
    if (result.exitCode === 0) io.stdout(rendered);
    else io.stderr(rendered);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`error: ${message}\n`);
    io.stderr(HELP);
    return 64;
  }
}
