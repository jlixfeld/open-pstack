import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROLE_MAP_PREAMBLE,
  defaultRoleMap,
  renderRoleMap,
} from "../routing/role-map.ts";
import { parseManifest } from "../routing/manifest.ts";
import { EFFORTS, MODEL_EFFORTS, type Effort } from "./types.ts";

const PLUGIN_ROOT = join(import.meta.dir, "../../../..");
const DISPATCH_PATH = join(
  PLUGIN_ROOT,
  "skills/poteto-mode/references/provider-dispatch.md"
);
const SETUP_PATH = join(PLUGIN_ROOT, "skills/setup-pstack/SKILL.md");
const POTETO_MODE_PATH = join(PLUGIN_ROOT, "skills/poteto-mode/SKILL.md");
const CODEX_TOOLS_PATH = join(
  PLUGIN_ROOT,
  "skills/poteto-mode/references/codex-tools.md"
);
const SESSION_START_PATH = join(PLUGIN_ROOT, "hooks/session-start-context.md");
const AGENTS_DIR = join(PLUGIN_ROOT, "agents");
const ROUTING_DESIGN_PATH = join(PLUGIN_ROOT, "../../docs/tiered-routing-design.md");

const MATRIX_HEADER = [
  "Family",
  "Upstream pstack choice",
  "Provider",
  "Model",
  "Default effort",
  "Selectable efforts",
  "Claude-native agent stem",
] as const;

const FAMILY_ORDER = ["fable", "sol", "terra", "luna", "grok", "opus"] as const;
const PROVIDERS = ["claude", "codex", "grok"] as const;
const DESCRIPTOR_RE =
  /(claude|codex|grok):[a-z0-9.-]+@(low|medium|high|xhigh|max|ultra)/g;
const PANEL_ROLES = [
  "how critics",
  "arena runners",
  "arena cross-judge pool",
  "architect runners",
  "interrogate reviewers",
] as const;
const SHEET_ROLES = [
  "feature implementation",
  "refactoring implementation",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "judgment and prose",
  "hardest tasks",
  "how explorer",
  "how explainer",
  "how critics",
  "why investigators, synthesizer",
  "reflect tooling, judgment, divergent, synthesizer",
  "arena runners",
  "arena cross-judge pool",
  "swarm workers",
  "architect runners",
  "interrogate reviewers",
] as const;
const SETUP_SECTION_ORDER = [
  "### 2. Load current state",
  "### 3. Parse per-family efforts",
  "### 4. Apply named role edits",
  "### 5. Probe the final map",
  "### 6. Render the exact final map",
  "### 7. Confirm and commit",
] as const;

interface MatrixRow {
  family: string;
  upstreamChoice: string;
  provider: string;
  model: string;
  defaultEffort: Effort;
  selectableEfforts: Effort[];
  claudeNativeAgentStem: string | null;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    throw new Error(`matrix row must be a pipe table: ${line}`);
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim().replaceAll("`", ""));
}

function isSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function asEffort(value: string): Effort {
  if ((EFFORTS as readonly string[]).includes(value)) {
    return value as Effort;
  }
  throw new Error(`not an effort: ${value}`);
}

function parseModelMatrix(markdown: string): MatrixRow[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Model matrix");
  if (start < 0) {
    throw new Error("missing ## Model matrix");
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const table = lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  if (table.length !== 8) {
    throw new Error(
      `model matrix must be header, separator, and 6 data rows, got ${table.length}`
    );
  }
  const header = splitRow(table[0]);
  if (header.join("|") !== MATRIX_HEADER.join("|")) {
    throw new Error(`unexpected matrix header: ${header.join(" | ")}`);
  }
  if (!isSeparator(splitRow(table[1]))) {
    throw new Error("matrix header separator missing");
  }
  return table.slice(2).map((line) => {
    const cells = splitRow(line);
    if (cells.length !== MATRIX_HEADER.length) {
      throw new Error(`matrix row has ${cells.length} cells: ${line}`);
    }
    const [
      family,
      upstreamChoice,
      provider,
      model,
      defaultEffortRaw,
      selectableRaw,
      stemRaw,
    ] = cells;
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`invalid provider: ${provider}`);
    }
    const selectableEfforts = selectableRaw.split(/\s+/).map(asEffort);
    const claudeNativeAgentStem = stemRaw === "-" ? null : stemRaw;
    if (claudeNativeAgentStem !== null && !/^[a-z0-9-]+$/.test(claudeNativeAgentStem)) {
      throw new Error(`invalid Claude-native agent stem: ${stemRaw}`);
    }
    if ((provider === "claude") !== (claudeNativeAgentStem !== null)) {
      throw new Error(`${family} stem must be present iff provider is claude`);
    }
    const defaultEffort = asEffort(defaultEffortRaw);
    if (!selectableEfforts.includes(defaultEffort)) {
      throw new Error(`${family} default effort is not selectable`);
    }
    return {
      family,
      upstreamChoice,
      provider,
      model,
      defaultEffort,
      selectableEfforts,
      claudeNativeAgentStem,
    };
  });
}

function parseFrontmatter(text: string): {
  fields: Record<string, string>;
  body: string;
} {
  if (!text.startsWith("---\n")) {
    throw new Error("missing frontmatter");
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error("unterminated frontmatter");
  }
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const idx = line.indexOf(": ");
    if (idx < 0) {
      throw new Error(`bad frontmatter line: ${line}`);
    }
    fields[line.slice(0, idx)] = line.slice(idx + 2);
  }
  return { fields, body: text.slice(end + 5) };
}

function firstRunSheet(setup: string): string {
  const match = setup.match(
    /```markdown\n(# pstack model configuration\n[\s\S]*?)```/
  );
  if (!match) {
    throw new Error("setup-pstack is missing the first-run sheet fence");
  }
  return match[1];
}

describe("model matrix", () => {
  const rows = parseModelMatrix(readFileSync(DISPATCH_PATH, "utf8"));
  const manifest = parseManifest(readFileSync(DISPATCH_PATH, "utf8"));
  const setup = readFileSync(SETUP_PATH, "utf8");

  it("owns the effort universe and first-run defaults", () => {
    expect([...EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(rows.map((row) => row.family)).toEqual([...FAMILY_ORDER]);
    for (const row of rows) {
      expect(row.upstreamChoice.length).toBeGreaterThan(0);
      expect(row.model.length).toBeGreaterThan(0);
      expect(row.selectableEfforts.length).toBeGreaterThan(0);
      expect(row.selectableEfforts).toEqual(
        EFFORTS.filter((effort) => row.selectableEfforts.includes(effort))
      );
    }
    expect(
      rows.map((row) => [row.family, row.defaultEffort])
    ).toEqual([
      ["fable", "max"],
      ["sol", "max"],
      ["terra", "high"],
      ["luna", "high"],
      ["grok", "xhigh"],
      ["opus", "xhigh"],
    ]);
    expect(rows.find((row) => row.family === "fable")?.model).toBe("claude-fable-5-1");
    const documentedEfforts = rows.map((row) => [
      `${row.provider}:${row.model}`,
      row.selectableEfforts,
    ] as const).sort(([left], [right]) => left.localeCompare(right));
    const runnerEfforts = Object.entries(MODEL_EFFORTS)
      .sort(([left], [right]) => left.localeCompare(right));
    expect(JSON.stringify(documentedEfforts)).toBe(JSON.stringify(runnerEfforts));
  });

  it("ships exactly the declared Claude-native frontier agents", () => {
    const expected = new Set<string>();
    const familyBodies = new Map<string, string>();
    for (const row of rows) {
      const stem = row.claudeNativeAgentStem;
      if (stem === null) {
        continue;
      }
      for (const effort of row.selectableEfforts) {
        const name = `pstack-${stem}-${effort}`;
        expected.add(`${name}.md`);
        const text = readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8");
        const { fields, body } = parseFrontmatter(text);
        expect(fields).toEqual({
          name,
          description: `Native Claude lane for pstack roles configured as ${row.provider}:${row.model}@${effort}.`,
          model: row.model,
          effort,
          background: "true",
          disallowedTools: "Agent, Task",
        });
        const prior = familyBodies.get(stem);
        if (prior === undefined) {
          familyBodies.set(stem, body);
        } else {
          expect(body).toBe(prior);
        }
      }
    }
    const declaredCount = rows.reduce(
      (count, row) =>
        count +
        (row.claudeNativeAgentStem === null
          ? 0
          : row.selectableEfforts.length),
      0
    );
    expect(expected.size).toBe(declaredCount);
    const shipped = readdirSync(AGENTS_DIR)
      .filter((name) => name.startsWith("pstack-") && name.endsWith(".md"))
      .sort();
    expect(shipped).toEqual([...expected].sort());
  });

  it("keeps setup's first-run default panel copy aligned with the matrix", () => {
    const sheet = firstRunSheet(setup);
    expect(sheet).toBe(renderRoleMap(defaultRoleMap(manifest)));
    expect(ROLE_MAP_PREAMBLE).toContain("standing authorization");
    expect(ROLE_MAP_PREAMBLE).toContain("source-code egress approval");
    const roles = sheet
      .split("\n")
      .filter((line) => line.includes(": "))
      .map((line) => line.slice(0, line.indexOf(": ")));
    expect(roles).toEqual([...SHEET_ROLES]);
    const byFamily = new Map<string, MatrixRow>(
      rows.map((row) => [`${row.provider}:${row.model}`, row])
    );
    for (const descriptor of sheet.match(DESCRIPTOR_RE) ?? []) {
      const at = descriptor.lastIndexOf("@");
      const key = descriptor.slice(0, at);
      const effort = descriptor.slice(at + 1);
      const row = byFamily.get(key);
      if (row === undefined) {
        throw new Error(`unknown first-run descriptor: ${descriptor}`);
      }
      expect(row.selectableEfforts).toContain(asEffort(effort));
    }
    const expectedPanels = new Map([
      ["how critics", "codex:gpt-5.6-sol@max, claude:claude-fable-5-1@xhigh"],
      ["arena runners", "codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh"],
      ["arena cross-judge pool", "codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh"],
      ["architect runners", "codex:gpt-5.6-sol@max, claude:claude-opus-5@xhigh"],
      ["interrogate reviewers", "codex:gpt-5.6-sol@max, claude:claude-fable-5-1@xhigh"],
    ]);
    for (const role of PANEL_ROLES) {
      const line = sheet
        .split("\n")
        .find((entry) => entry.startsWith(`${role}:`));
      if (line === undefined) {
        throw new Error(`missing first-run panel row: ${role}`);
      }
      expect(line).toBe(`${role}: ${expectedPanels.get(role)}`);
    }
  });

  it("keeps workflow consumer defaults aligned with the role registry", () => {
    const consumer = (roleName: string) => {
      const role = manifest.roles.find((entry) => entry.name === roleName);
      if (role === undefined) throw new Error(`missing role: ${roleName}`);
      return role.firstRunLanes.map((lane) => `\`${lane}\``);
    };
    const arena = readFileSync(join(PLUGIN_ROOT, "skills/arena/SKILL.md"), "utf8");
    expect(arena).toContain(`Otherwise default to ${consumer("arena runners").join(", ")}.`);
    expect(arena).toContain(`otherwise from ${consumer("arena cross-judge pool").join(", ")}.`);
    const architect = readFileSync(join(PLUGIN_ROOT, "skills/architect/SKILL.md"), "utf8");
    expect(architect).toContain(`defaults ${consumer("architect runners").join(", ")})`);
    const how = readFileSync(join(PLUGIN_ROOT, "skills/how/SKILL.md"), "utf8");
    expect(how).toContain(`default ${consumer("how explorer")[0]})`);
    expect(how).toContain(`default ${consumer("how explainer")[0]})`);
    expect(how).toContain(`defaults ${consumer("how critics").join(", ")})`);
    const interrogate = readFileSync(join(PLUGIN_ROOT, "skills/interrogate/SKILL.md"), "utf8");
    expect(interrogate).toContain([
      ...consumer("interrogate reviewers").map((lane, index) =>
        `| Reviewer ${String.fromCharCode("A".charCodeAt(0) + index)} | ${lane} |`
      ),
      "",
      "For each reviewer",
    ].join("\n"));
    const swarm = readFileSync(join(PLUGIN_ROOT, "skills/swarm/SKILL.md"), "utf8");
    expect(swarm).toContain(`Otherwise use ${consumer("swarm workers")[0]}.`);
    const reference = readFileSync(join(PLUGIN_ROOT, "../../docs/reference.md"), "utf8");
    expect(reference).toContain(
      `Initial Arena and Architect panels use ${consumer("arena runners").join(", ")}, one model per active provider. How critics and Interrogate use ${consumer("how critics").join(", ")}.`
    );
    expect(reference).toContain(
      "Arena and Architect use one Sol lane and one Opus lane, one model per active provider."
    );
    const design = readFileSync(ROUTING_DESIGN_PATH, "utf8");
    expect(design).toContain(`hardest tasks: ${consumer("hardest tasks")[0].slice(1, -1)}`);
    expect(design).toContain(`how critics: ${consumer("how critics").map((lane) => lane.slice(1, -1)).join(", ")}`);
    expect(design).toContain(`interrogate reviewers: ${consumer("interrogate reviewers").map((lane) => lane.slice(1, -1)).join(", ")}`);
  });

  it("keeps setup's fail-closed reconfiguration order", () => {
    let previous = -1;
    for (const heading of SETUP_SECTION_ORDER) {
      const current = setup.indexOf(heading);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    expect(setup).toContain("Do not probe or write while any inconsistency is unresolved.");
    expect(setup).toContain("A failed probe writes nothing:");
    expect(setup).toContain("one probe for each distinct exact");
    expect(setup).toContain("normalized complete role map from step 2");
    expect(setup).toContain("Every documented role remains present.");
    expect(setup).toContain("<!-- pstack:models:begin -->");
    expect(setup).toContain("<!-- pstack:models:end -->");
  });

  it("binds Claude-native dispatch to the matrix mapping", () => {
    const dispatch = readFileSync(DISPATCH_PATH, "utf8");
    const nativeStart = dispatch.indexOf("## Native lanes");
    const externalStart = dispatch.indexOf("## External lanes");
    expect(nativeStart).toBeGreaterThan(-1);
    expect(externalStart).toBeGreaterThan(nativeStart);
    const nativeLanes = dispatch.slice(nativeStart, externalStart);
    expect(nativeLanes).toContain(
      "match the descriptor's `(provider, model)` to one model-matrix row"
    );
    expect(nativeLanes).toContain("`pstack-<stem>-<effort>`");
  });

  it("documents the scoped Codex exception for macOS Keychain authentication", () => {
    const dispatch = readFileSync(DISPATCH_PATH, "utf8");
    const externalStart = dispatch.indexOf("## External lanes");
    const completionStart = dispatch.indexOf("## Completion and dropouts");
    const externalLanes = dispatch.slice(externalStart, completionStart);
    expect(externalLanes).toContain("macOS Keychain");
    expect(externalLanes).toContain('`sandbox_permissions: "require_escalated"`');
    expect(externalLanes).toContain('`parent: "codex"`');
    expect(externalLanes).toContain('`provider: "claude"`');
    expect(externalLanes).toContain('`status: "unauthenticated"`');
    expect(externalLanes).toContain('`preflight.status: "failed"`');
    expect(externalLanes).not.toContain('`exitCode: 0`');
    expect(externalLanes).toContain(
      "returned a parseable JSON object with boolean `loggedIn: false`"
    );
    expect(externalLanes).toContain("The exit code does not change this classification");
    expect(externalLanes).toContain(
      "Do not infer this condition from `preflight.evidence`"
    );
    expect(externalLanes).toContain(
      "Keep `--parent`, `--provider`, `--model`, `--effort`, `--mode`, `--prompt`, `--cwd`, and `--timeout` exactly the same"
    );
    expect(externalLanes).toContain(
      "Use fresh unique paths for `--output` and `--receipt`"
    );
    expect(externalLanes).toContain("The new paths must not exist");
    expect(externalLanes).toContain("Preserve the first receipt");
    expect(externalLanes).toContain("Do not read, print, copy, or export the credential");
    expect(externalLanes).toContain("still reports unauthenticated");
  });

  it("requires user acknowledgment before provider context transmission", () => {
    const dispatch = readFileSync(DISPATCH_PATH, "utf8");
    const authorizationStart = dispatch.indexOf("## Authorization boundary");
    const routingStart = dispatch.indexOf("## The parent owns the route");
    const externalStart = dispatch.indexOf("## External lanes");
    expect(authorizationStart).toBeGreaterThan(-1);
    expect(routingStart).toBeGreaterThan(authorizationStart);
    expect(externalStart).toBeGreaterThan(routingStart);
    const authorization = dispatch.slice(authorizationStart, routingStart);
    expect(authorization).toContain("standing authorization");
    expect(authorization).toContain("explicit user invocation");
    expect(authorization).toContain("operator-confirmed model sheet");
    expect(authorization).toContain(
      "Automatic SessionStart routing is not authorization"
    );
    expect(authorization).toContain("repository source code");
    expect(authorization).toContain("diffs");
    expect(authorization).toContain("every supported pstack parent");
    expect(authorization).toContain("including Claude Code and Codex");
    expect(authorization).toContain("Claude, Codex, Grok, and any future configured provider");
    expect(authorization).toContain("native and external lanes");
    expect(authorization).toContain(
      "Do not request separate source-code egress approval"
    );
    expect(authorization).toContain(
      "writes beyond the lane's assigned access mode"
    );
    expect(readFileSync(POTETO_MODE_PATH, "utf8")).toContain(
      "authorization boundary"
    );
    expect(readFileSync(CODEX_TOOLS_PATH, "utf8")).toContain(
      "authorization boundary"
    );
    expect(ROLE_MAP_PREAMBLE).toContain(
      "Confirming this model sheet is standing authorization"
    );
    expect(readFileSync(SESSION_START_PATH, "utf8")).toContain(
      "does not authorize provider egress"
    );
  });
});
