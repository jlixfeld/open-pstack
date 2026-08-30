import type { Effort, Manifest, Provider, RoleDefinition } from "./manifest.ts";

export type Alias = "inherit-parent" | "auto";
export type Lane = Descriptor | Alias;

export interface Descriptor {
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
}

export interface RoleAssignment {
  readonly role: string;
  readonly lanes: readonly Lane[];
}

const DESCRIPTOR = /^(claude|codex|grok):([a-z0-9.-]+)@(low|medium|high|xhigh|max|ultra)$/;

function provider(value: string): Provider {
  if (value === "claude" || value === "codex" || value === "grok") return value;
  throw new Error(`invalid provider: ${value}`);
}

function effort(value: string): Effort {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return value;
    default:
      throw new Error(`invalid effort: ${value}`);
  }
}

export function parseLane(value: string, manifest: Manifest): Lane {
  const trimmed = value.trim();
  if (trimmed === "inherit-parent" || trimmed === "auto") return trimmed;
  const match = DESCRIPTOR.exec(trimmed);
  if (match === null) throw new Error(`invalid descriptor: ${value}`);
  const parsed = { provider: provider(match[1]), model: match[2], effort: effort(match[3]) };
  const family = manifest.families.find((entry) => entry.provider === parsed.provider && entry.model === parsed.model);
  if (family === undefined) throw new Error(`unknown descriptor family: ${trimmed}`);
  if (!family.efforts.includes(parsed.effort)) throw new Error(`invalid effort for ${parsed.provider}:${parsed.model}: ${parsed.effort}`);
  return parsed;
}

function roleDefinition(manifest: Manifest, name: string): RoleDefinition {
  const definition = manifest.roles.find((role) => role.name === name);
  if (definition === undefined) throw new Error(`unknown role: ${name}`);
  return definition;
}

function validateAssignment(assignment: RoleAssignment, manifest: Manifest): RoleAssignment {
  const definition = roleDefinition(manifest, assignment.role);
  if (assignment.lanes.length === 0) throw new Error(`${assignment.role} has no lanes`);
  if (definition.shape === "single" && assignment.lanes.length !== 1) throw new Error(`${assignment.role} must have exactly one lane`);
  return assignment;
}

function sheetRows(sheet: string): readonly { readonly role: string; readonly lanes: string }[] {
  return sheet.split(/\r?\n/).flatMap((line) => {
    if (line.startsWith("#") || !line.includes(": ")) return [];
    const delimiter = line.indexOf(": ");
    return [{ role: line.slice(0, delimiter).trim(), lanes: line.slice(delimiter + 2).trim() }];
  });
}

export function defaultRoleMap(manifest: Manifest): readonly RoleAssignment[] {
  return manifest.roles.map((role) => validateAssignment({
    role: role.name,
    lanes: role.firstRunLanes.map((lane) => parseLane(lane, manifest)),
  }, manifest));
}

export function parseRoleMap(sheet: string, manifest: Manifest): readonly RoleAssignment[] {
  const rows = sheetRows(sheet);
  const assignments: RoleAssignment[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const legacy = row.role === "feature, refactoring";
    const names = legacy ? ["feature implementation", "refactoring implementation"] : [row.role];
    for (const name of names) {
      if (seen.has(name)) throw new Error(`duplicate role: ${name}`);
      seen.add(name);
      assignments.push(validateAssignment({
        role: name,
        lanes: row.lanes.split(",").map((lane) => parseLane(lane, manifest)),
      }, manifest));
    }
  }
  const known = new Set(manifest.roles.map((role) => role.name));
  for (const assignment of assignments) if (!known.has(assignment.role)) throw new Error(`unknown role: ${assignment.role}`);
  const defaults = new Map(defaultRoleMap(manifest).map((assignment) => [assignment.role, assignment]));
  const byRole = new Map(assignments.map((assignment) => [assignment.role, assignment]));
  return manifest.roles.map((role) => {
    const assignment = byRole.get(role.name) ?? defaults.get(role.name);
    if (assignment === undefined) throw new Error(`missing default role: ${role.name}`);
    return assignment;
  });
}

export function applyRoleEdits(current: readonly RoleAssignment[], edits: readonly RoleAssignment[], manifest: Manifest): readonly RoleAssignment[] {
  const editMap = new Map<string, RoleAssignment>();
  for (const edit of edits) {
    const parsed = {
      role: edit.role,
      lanes: edit.lanes.map((lane) => parseLane(renderLane(lane), manifest)),
    };
    if (editMap.has(parsed.role)) throw new Error(`duplicate role edit: ${parsed.role}`);
    editMap.set(parsed.role, validateAssignment(parsed, manifest));
  }
  return current.map((assignment) => editMap.get(assignment.role) ?? assignment);
}

export function renderLane(lane: Lane): string {
  return typeof lane === "string" ? lane : `${lane.provider}:${lane.model}@${lane.effort}`;
}

export function renderRoleMap(assignments: readonly RoleAssignment[]): string {
  const body = assignments.map((assignment) => `${assignment.role}: ${assignment.lanes.map(renderLane).join(", ")}`).join("\n");
  return `# pstack model configuration\n\nProvider-qualified per-role choices. \`inherit-parent\` and \`auto\` use the parent model natively and still count as one stored lane.\n\n${body}\n`;
}

export function probePlan(assignments: readonly RoleAssignment[]): readonly Descriptor[] {
  const unique = new Map<string, Descriptor>();
  for (const assignment of assignments) for (const lane of assignment.lanes) {
    if (typeof lane === "string") continue;
    unique.set(renderLane(lane), lane);
  }
  return [...unique.values()];
}
