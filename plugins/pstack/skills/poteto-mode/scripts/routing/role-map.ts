import { EFFORTS, oneOf, PROVIDERS, type Effort, type Manifest, type Provider, type RoleDefinition } from "./manifest.ts";

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

export const ROLE_MAP_PREAMBLE = "Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one stored lane.";

export function parseLane(value: string, manifest: Manifest): Lane {
  const trimmed = value.trim();
  if (trimmed === "inherit-parent" || trimmed === "auto") return trimmed;
  const match = /^([^:]+):([^@]+)@([^@]+)$/.exec(trimmed);
  if (match === null) throw new Error(`invalid descriptor: ${value}`);
  const parsed = {
    provider: oneOf(match[1], PROVIDERS, "provider") as Provider,
    model: match[2],
    effort: oneOf(match[3], EFFORTS, "effort") as Effort,
  };
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
  const rows: { role: string; lanes: string }[] = [];
  for (const line of sheet.split(/\r?\n/)) {
    if (line.startsWith("#") || !line.includes(": ")) continue;
    const delimiter = line.indexOf(": ");
    const role = line.slice(0, delimiter).trim();
    rows.push({ role, lanes: line.slice(delimiter + 2).trim() });
  }
  return rows;
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
  const byRole = new Map(assignments.map((assignment) => [assignment.role, assignment]));
  return defaultRoleMap(manifest).map((assignment) => byRole.get(assignment.role) ?? assignment);
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
  return `# pstack model configuration\n\n${ROLE_MAP_PREAMBLE}\n\n${body}\n`;
}

export function probePlan(assignments: readonly RoleAssignment[]): readonly Descriptor[] {
  const unique = new Map<string, Descriptor>();
  for (const assignment of assignments) for (const lane of assignment.lanes) {
    if (typeof lane === "string") continue;
    unique.set(renderLane(lane), lane);
  }
  return [...unique.values()];
}
