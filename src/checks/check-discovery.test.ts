import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProjectChecks } from "./check-discovery.js";
import type { PackageManager } from "../types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function project(packageJson: unknown): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-check-discovery-"));
  directories.push(cwd);
  await writeFile(path.join(cwd, "package.json"), JSON.stringify(packageJson));
  return cwd;
}

describe("project check discovery", () => {
  const cases: Array<{ manager: PackageManager; expected: string[] }> = [
    { manager: "npm", expected: ["npm test -- --watchAll=false --passWithNoTests", "npm run typecheck", "npm run lint", "npm run build"] },
    { manager: "pnpm", expected: ["pnpm test -- --watchAll=false --passWithNoTests", "pnpm run typecheck", "pnpm run lint", "pnpm run build"] },
    { manager: "yarn", expected: ["yarn test --watchAll=false --passWithNoTests", "yarn run typecheck", "yarn run lint", "yarn run build"] },
    { manager: "bun", expected: ["bun run test -- --watchAll=false --passWithNoTests", "bun run typecheck", "bun run lint", "bun run build"] }
  ];

  for (const { manager, expected } of cases) {
    it(`builds ordered ${manager} commands`, async () => {
      const cwd = await project({
        packageManager: `${manager}@1.2.3`,
        scripts: { build: "build", lint: "lint", test: "react-scripts test", typecheck: "tsc --noEmit", start: "serve" }
      });
      const result = await discoverProjectChecks(cwd);
      expect(result.packageManager).toBe(manager);
      expect(result.scripts).toEqual(["test", "typecheck", "lint", "build"]);
      expect(result.commands).toEqual(expected);
    });
  }

  it("uses packageManager before conflicting lockfiles", async () => {
    const cwd = await project({ packageManager: "pnpm@9.0.0", scripts: { test: "vitest run" } });
    await writeFile(path.join(cwd, "package-lock.json"), "{}");
    await writeFile(path.join(cwd, "yarn.lock"), "");
    const result = await discoverProjectChecks(cwd);
    expect(result.packageManager).toBe("pnpm");
    expect(result.commands).toEqual(["pnpm test"]);
  });

  it("refuses to guess when lockfiles conflict", async () => {
    const cwd = await project({ scripts: { test: "vitest run" } });
    await writeFile(path.join(cwd, "package-lock.json"), "{}");
    await writeFile(path.join(cwd, "pnpm-lock.yaml"), "");
    const result = await discoverProjectChecks(cwd);
    expect(result.commands).toEqual([]);
    expect(result.diagnostics.join(" ")).toContain("Conflicting");
  });

  it("defaults to npm without a packageManager or lockfile", async () => {
    const cwd = await project({ scripts: { build: "vite build" } });
    expect(await discoverProjectChecks(cwd)).toMatchObject({ packageManager: "npm", commands: ["npm run build"] });
  });

  it("skips the default failing test placeholder", async () => {
    const cwd = await project({ scripts: { test: "echo \"Error: no test specified\" && exit 1", build: "vite build" } });
    const result = await discoverProjectChecks(cwd);
    expect(result.commands).toEqual(["npm run build"]);
    expect(result.diagnostics.join(" ")).toContain("placeholder");
  });

  it("returns diagnostics without guessing for missing or malformed manifests", async () => {
    const missing = await mkdtemp(path.join(os.tmpdir(), "pi-check-discovery-"));
    directories.push(missing);
    expect((await discoverProjectChecks(missing)).commands).toEqual([]);
    await writeFile(path.join(missing, "package.json"), "{broken");
    expect((await discoverProjectChecks(missing)).diagnostics.join(" ")).toContain("Could not parse");
  });
});
