import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const agentsDir = join(import.meta.dir, "../../../../agents");
const stems: Record<string, string> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
};
const efforts = ["low", "medium", "high", "xhigh", "max"];

function frontmatter(file: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(agentsDir, file), "utf8"));
  if (!match) throw new Error(`${file}: missing frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 2);
  }
  return fields;
}

describe("shipped Claude lane agents", () => {
  it("ships every stem at every effort and nothing else with the lane prefix", () => {
    const expected = Object.keys(stems).flatMap((stem) => efforts.map((effort) => `pstack-${stem}-${effort}.md`));
    const shipped = readdirSync(agentsDir).filter((file) => file.startsWith("pstack-"));
    expect(shipped.sort()).toEqual(expected.sort());
    expect(expected).toHaveLength(15);
  });

  for (const [stem, model] of Object.entries(stems)) {
    for (const effort of efforts) {
      it(`pstack-${stem}-${effort} pins ${model} at ${effort}`, () => {
        const fields = frontmatter(`pstack-${stem}-${effort}.md`);
        expect(fields.name).toBe(`pstack-${stem}-${effort}`);
        expect(fields.model).toBe(model);
        expect(fields.effort).toBe(effort);
        expect(fields.disallowedTools).toBe("Agent, Task");
        expect(fields.background).toBeUndefined();
        expect(fields.description).toContain(`claude:${model}@${effort}`);
      });
    }
  }
});
