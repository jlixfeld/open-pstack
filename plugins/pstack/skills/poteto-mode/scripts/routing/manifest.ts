export const PROVIDERS = ["claude", "codex", "grok"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const ROLE_SHAPES = ["single", "panel", "pool"] as const;

export type Provider = (typeof PROVIDERS)[number];
export type Effort = (typeof EFFORTS)[number];
export type RoleShape = (typeof ROLE_SHAPES)[number];

export interface ModelFamily {
  readonly family: string;
  readonly provider: Provider;
  readonly model: string;
  readonly defaultEffort: Effort;
  readonly efforts: readonly Effort[];
  readonly claudeNativeAgentStem: string | null;
}

export interface RoleDefinition {
  readonly name: string;
  readonly shape: RoleShape;
  readonly firstRunLanes: readonly string[];
}

export interface Manifest {
  readonly families: readonly ModelFamily[];
  readonly roles: readonly RoleDefinition[];
}

function tableRows(markdown: string, heading: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`missing ${heading}`);
  const table: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().slice(1, -1).split("|").map((cell) => cell.trim().replaceAll("`", ""));
    if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) table.push(cells);
  }
  return table;
}

function oneOf<T extends string>(value: string, choices: readonly T[], label: string): T {
  for (const choice of choices) if (choice === value) return choice;
  throw new Error(`invalid ${label}: ${value}`);
}

function nonEmpty(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

function parseFamilies(markdown: string): readonly ModelFamily[] {
  const rows = tableRows(markdown, "## Model matrix");
  if (rows.length < 2) throw new Error("model matrix has no families");
  const [, ...data] = rows;
  const families = data.map((cells) => {
    if (cells.length !== 7) throw new Error(`model matrix row has ${cells.length} cells`);
    const [family, , providerRaw, model, defaultEffortRaw, effortsRaw, stemRaw] = cells;
    const efforts = effortsRaw.split(/\s+/).filter(Boolean).map((effort) => oneOf(effort, EFFORTS, "effort"));
    const defaultEffort = oneOf(defaultEffortRaw, EFFORTS, "default effort");
    if (!efforts.includes(defaultEffort)) throw new Error(`${family} default effort is not selectable`);
    return {
      family: nonEmpty(family, "family"),
      provider: oneOf(providerRaw, PROVIDERS, "provider"),
      model: nonEmpty(model, "model"),
      defaultEffort,
      efforts,
      claudeNativeAgentStem: stemRaw === "-" ? null : nonEmpty(stemRaw, "agent stem"),
    };
  });
  const keys = new Set<string>();
  for (const family of families) {
    const key = `${family.provider}:${family.model}`;
    if (keys.has(key)) throw new Error(`duplicate model family: ${key}`);
    keys.add(key);
  }
  return families;
}

function parseRoles(markdown: string): readonly RoleDefinition[] {
  const rows = tableRows(markdown, "## Role registry");
  if (rows.length < 2) throw new Error("role registry has no roles");
  const [, ...data] = rows;
  const roles = data.map((cells) => {
    if (cells.length !== 3) throw new Error(`role registry row has ${cells.length} cells`);
    const [name, shapeRaw, lanesRaw] = cells;
    const lanes = lanesRaw.split(",").map((lane) => lane.trim()).filter(Boolean);
    if (lanes.length === 0) throw new Error(`${name} has no lanes`);
    const shape = oneOf(shapeRaw, ROLE_SHAPES, "role shape");
    if (shape === "single" && lanes.length !== 1) throw new Error(`${name} must have exactly one lane`);
    return { name: nonEmpty(name, "role"), shape, firstRunLanes: lanes };
  });
  const names = new Set<string>();
  for (const role of roles) {
    if (names.has(role.name)) throw new Error(`duplicate role: ${role.name}`);
    names.add(role.name);
  }
  return roles;
}

export function parseManifest(markdown: string): Manifest {
  return { families: parseFamilies(markdown), roles: parseRoles(markdown) };
}
