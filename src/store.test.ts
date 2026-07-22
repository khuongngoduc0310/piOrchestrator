import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "./store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("RunStore", () => {
  it("creates unique qualifier-aware artifact names", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-store-"));
    directories.push(cwd);
    const store = new RunStore(cwd, "run");
    const first = store.artifactName({ sequence: 1, stage: "implementing", agent: "builder", attempt: 1, kind: "output" });
    const second = store.artifactName({ sequence: 2, stage: "implementing", agent: "builder", attempt: 2, kind: "output" });
    expect(first).not.toBe(second);
    await Promise.all([store.saveJson(first, { n: 1 }), store.saveJson(second, { n: 2 })]);
    await store.flush();
    expect(await readdir(store.runDir)).toEqual(expect.arrayContaining([first, second]));
  });

  it("serializes event appends in monotonic order and flushes pending writes", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-store-"));
    directories.push(cwd);
    const store = new RunStore(cwd, "run");
    for (let index = 0; index < 30; index++) void store.event("test", { index });
    await store.flush();
    const lines = (await readFile(path.join(store.runDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines.map(line => line.sequence)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(lines.map(line => line.payload.index)).toEqual(Array.from({ length: 30 }, (_, index) => index));
  });
});
