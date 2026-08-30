import { resolveRoute, type Parent } from "../routing/dispatch.ts";
import { parseManifest, type Manifest } from "../routing/manifest.ts";
import {
  applyRoleEdits,
  defaultRoleMap,
  parseRoleMap,
  probePlan,
  renderLane,
  renderRoleMap,
  type Descriptor,
  type RoleAssignment,
} from "../routing/role-map.ts";

export interface Snapshot {
  readonly path: string;
  readonly bytes: Uint8Array | null;
}

export interface RenderedTarget extends Snapshot {
  readonly nextBytes: Uint8Array;
}

export interface PreparedSetup {
  readonly parent: Parent;
  readonly manifest: Manifest;
  readonly roles: readonly RoleAssignment[];
  readonly probes: readonly Descriptor[];
  readonly preview: readonly string[];
  readonly targets: readonly RenderedTarget[];
}

export interface PrepareInput {
  readonly parent: Parent;
  readonly manifestMarkdown: string;
  readonly sheet: Snapshot;
  readonly integration: Snapshot;
  readonly edits?: readonly RoleAssignment[];
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

function integration(parent: Parent, existing: string | null, sheet: string): string {
  if (parent === "claude") {
    const include = "@~/.claude/pstack-models.md";
    if (existing === null || existing.length === 0) return `${include}\n`;
    const includes = existing.split(/\r?\n/).filter((line) => line.trim() === include);
    if (includes.length > 1) throw new Error("duplicate Claude pstack include");
    return includes.length === 1 ? existing : `${existing.replace(/\s*$/, "")}\n${include}\n`;
  }
  const begin = "<!-- pstack:models:begin -->";
  const end = "<!-- pstack:models:end -->";
  const source = existing ?? "";
  const begins = source.split(begin).length - 1;
  const ends = source.split(end).length - 1;
  if (begins !== ends || begins > 1) throw new Error("inconsistent Codex pstack markers");
  const block = `${begin}\n${sheet}${end}`;
  if (begins === 0) return `${source.replace(/\s*$/, "")}${source.trim().length === 0 ? "" : "\n\n"}${block}\n`;
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start);
  if (finish < start) throw new Error("reversed Codex pstack markers");
  return `${source.slice(0, start)}${block}${source.slice(finish + end.length)}`;
}

function preview(parent: Parent, roles: readonly RoleAssignment[]): readonly string[] {
  return roles.flatMap((role) => role.lanes.map((lane, index) => {
    const descriptor = renderLane(lane);
    const provider = typeof lane === "string" ? lane : lane.provider;
    return `${role.role} [${index + 1}]: ${descriptor} (${resolveRoute(parent, provider)})`;
  }));
}

export function prepareSetup(input: PrepareInput): PreparedSetup {
  const manifest = parseManifest(input.manifestMarkdown);
  const current = input.sheet.bytes === null ? defaultRoleMap(manifest) : parseRoleMap(text(input.sheet.bytes) ?? "", manifest);
  const roles = applyRoleEdits(current, input.edits ?? [], manifest);
  const sheetText = renderRoleMap(roles);
  const integrationText = integration(input.parent, text(input.integration.bytes), sheetText);
  return {
    parent: input.parent,
    manifest,
    roles,
    probes: probePlan(roles),
    preview: preview(input.parent, roles),
    targets: [
      { ...input.sheet, nextBytes: utf8(sheetText) },
      { ...input.integration, nextBytes: utf8(integrationText) },
    ],
  };
}
