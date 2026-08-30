import { expect, it } from "bun:test";
import { parseJsonArrays } from "./github.ts";

it("parses every paginated GitHub array without being confused by brackets in issue bodies", () => {
  expect(
    parseJsonArrays(
      '[{"number":1,"body":"[first]"}]\n[{"number":2,"body":"second"}]\n'
    )
  ).toEqual([
    { number: 1, body: "[first]" },
    { number: 2, body: "second" },
  ]);
});
