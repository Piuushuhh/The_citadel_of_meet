import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadProjectEnv } from "../src/env.js";

describe("loadProjectEnv", () => {
  it("overrides inherited variables, skips comments and blanks", () => {
    const dir = mkdtempSync(join(tmpdir(), "standin-env-"));
    const f = join(dir, ".env");
    writeFileSync(f, "# c\nSTANDIN_T_KEY=from-file\nSTANDIN_T_EMPTY=\nSTANDIN_T_Q=\"quoted\"\n");
    process.env.STANDIN_T_KEY = "stale-system-value";
    const loaded = loadProjectEnv(pathToFileURL(f));
    expect(process.env.STANDIN_T_KEY).toBe("from-file");
    expect(process.env.STANDIN_T_Q).toBe("quoted");
    expect(loaded).not.toContain("STANDIN_T_EMPTY");
  });
  it("returns nothing when the file is missing", () => {
    expect(loadProjectEnv(pathToFileURL(join(tmpdir(), "nope-standin", ".env")))).toEqual([]);
  });
});
