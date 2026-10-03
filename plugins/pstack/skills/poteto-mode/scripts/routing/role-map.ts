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

export const ROLE_MAP_PREAMBLE = "Provider-qualified per-role choices. Read the installed provider-dispatch reference before dispatching a configured role. Confirming this agent model map is standing authorization to send a configured role's assigned source code and task context to every selected provider; do not request separate source-code egress approval for a role selected from this confirmed map. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one stored lane.";
const MODEL_SLUG = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function parseLane(value: string, _manifest?: Manifest): Lane {
  return parseLaneSyntax(value);
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
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || !trimmed.includes(":")) continue;
    const delimiter = trimmed.indexOf(":");
    if (trimmed.slice(delimiter, delimiter + 2) !== ": ") throw new Error(`invalid role row: ${line}`);
    rows.push({ role: trimmed.slice(0, delimiter).trim(), lanes: trimmed.slice(delimiter + 2).trim() });
  }
  return rows;
}

function parseLaneSyntax(value: string): Lane {
  const trimmed = value.trim();
  if (trimmed === "inherit-parent" || trimmed === "auto") return trimmed;
  const match = /^([^:]+):([^@]+)@([^@]+)$/.exec(trimmed);
  if (match === null || !MODEL_SLUG.test(match[2])) throw new Error(`invalid descriptor: ${value}`);
  return {
    provider: oneOf(match[1], PROVIDERS, "provider"),
    model: match[2],
    effort: oneOf(match[3], EFFORTS, "effort"),
  };
}

function indexEdits(edits: readonly RoleAssignment[], manifest: Manifest): ReadonlyMap<string, RoleAssignment> {
  const indexed = new Map<string, RoleAssignment>();
  for (const edit of edits) {
    if (indexed.has(edit.role)) throw new Error(`duplicate role edit: ${edit.role}`);
    indexed.set(edit.role, validateAssignment({
      role: edit.role,
      lanes: edit.lanes.map((lane) => parseLane(renderLane(lane), manifest)),
    }, manifest));
  }
  return indexed;
}

export function parseRoleMap(sheet: string, manifest: Manifest, edits: readonly RoleAssignment[] = [], requireComplete = true): readonly RoleAssignment[] {
  const editMap = indexEdits(edits, manifest);
  const rows = sheetRows(sheet);
  const assignments: RoleAssignment[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const legacy = row.role === "feature, refactoring";
    const names = legacy ? ["feature implementation", "refactoring implementation"] : [row.role];
    for (const name of names) {
      if (seen.has(name)) throw new Error(`duplicate role: ${name}`);
      seen.add(name);
      roleDefinition(manifest, name);
      assignments.push(validateAssignment({
        role: name,
        lanes: row.lanes.split(",").map((lane) => parseLane(lane, manifest)),
      }, manifest));
    }
  }
  const byRole = new Map(assignments.map((assignment) => [assignment.role, assignment]));
  const missing = manifest.roles.filter((role) => !editMap.has(role.name) && !byRole.has(role.name)).map((role) => role.name);
  if (requireComplete && missing.length > 0) throw new Error(`missing shared agent model assignments: ${missing.join(", ")}. Configure each role in the current harness agent model map or with an explicit --edit.`);
  return manifest.roles.flatMap((role) => {
    const assignment = editMap.get(role.name) ?? byRole.get(role.name);
    return assignment === undefined ? [] : [assignment];
  });
}

export function renderLane(lane: Lane): string {
  return typeof lane === "string" ? lane : `${lane.provider}:${lane.model}@${lane.effort}`;
}

export function renderRoleMap(assignments: readonly RoleAssignment[]): string {
  const body = assignments.map((assignment) => `${assignment.role}: ${assignment.lanes.map(renderLane).join(", ")}`).join("\n");
  return `# shared agent model map\n\n${ROLE_MAP_PREAMBLE}\n\n${body}\n`;
}

export function probePlan(assignments: readonly RoleAssignment[]): readonly Descriptor[] {
  const unique = new Map<string, Descriptor>();
  for (const assignment of assignments) for (const lane of assignment.lanes) {
    if (typeof lane === "string") continue;
    unique.set(renderLane(lane), lane);
  }
  return [...unique.values()];
}
