import { describe, expect, it } from "bun:test";
import { replaceFileAtomically, type AtomicFileOperations } from "./integration.ts";

describe("replaceFileAtomically", () => {
  it("does not clean the temporary path after a successful rename", () => {
    const target = "/fixture/models.md";
    let renamed = false;
    let removals = 0;
    const operations: AtomicFileOperations = {
      exists: (path) => path === target ? false : renamed,
      isSymlink: () => false,
      makeParent: () => {},
      mode: () => 0o600,
      write: () => {},
      rename: () => { renamed = true; },
      remove: () => {
        removals += 1;
        throw new Error("cleanup ran after rename");
      },
    };

    expect(() => replaceFileAtomically(target, new Uint8Array([1]), operations, "nonce")).not.toThrow();
    expect(renamed).toBe(true);
    expect(removals).toBe(0);
  });

  it("cleans the temporary path after a failed rename", () => {
    let removals = 0;
    const operations: AtomicFileOperations = {
      exists: () => false,
      isSymlink: () => false,
      makeParent: () => {},
      mode: () => 0o600,
      write: () => {},
      rename: () => { throw new Error("rename failed"); },
      remove: () => { removals += 1; },
    };

    expect(() => replaceFileAtomically("/fixture/models.md", new Uint8Array([1]), operations, "nonce")).toThrow("rename failed");
    expect(removals).toBe(1);
  });
});
