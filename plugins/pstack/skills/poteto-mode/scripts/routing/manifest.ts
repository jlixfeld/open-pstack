export const PROVIDERS = ["claude", "codex", "grok"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const ROLE_SHAPES = ["single", "panel", "pool"] as const;

export type Provider = (typeof PROVIDERS)[number];
export type Effort = (typeof EFFORTS)[number];
export type RoleShape = (typeof ROLE_SHAPES)[number];

export interface RoleDefinition {
  readonly name: string;
  readonly shape: RoleShape;
}

export interface Manifest {
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

export function oneOf<T extends string>(value: string, choices: readonly T[], label: string): T {
  for (const choice of choices) if (choice === value) return choice;
  throw new Error(`invalid ${label}: ${value}`);
}

function nonEmpty(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

function parseRoles(markdown: string): readonly RoleDefinition[] {
  const rows = tableRows(markdown, "## Role registry");
  if (rows.length < 2) throw new Error("role registry has no roles");
  const [, ...data] = rows;
  const roles = data.map((cells) => {
    if (cells.length !== 2) throw new Error(`role registry row has ${cells.length} cells`);
    const [name, shapeRaw] = cells;
    const shape = oneOf(shapeRaw, ROLE_SHAPES, "role shape");
    return { name: nonEmpty(name, "role"), shape };
  });
  const names = new Set<string>();
  for (const role of roles) {
    if (names.has(role.name)) throw new Error(`duplicate role: ${role.name}`);
    names.add(role.name);
  }
  return roles;
}

export function parseManifest(markdown: string): Manifest {
  return { roles: parseRoles(markdown) };
}
