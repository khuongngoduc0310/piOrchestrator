import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  it("preserves exact artifact bytes", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-store-"));
    directories.push(cwd);
    const store = new RunStore(cwd, "run");
    const bytes = Buffer.from([0, 1, 2, 10, 255]);
    await store.saveBuffer("invocation.patch", bytes);
    expect(await readFile(path.join(store.runDir, "invocation.patch"))).toEqual(bytes);
  });

  it("opens an existing run and restores event sequence", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-store-"));
    directories.push(cwd);
    const first = new RunStore(cwd, "run");
    await first.event("first", {});
    await first.flush();
    const reopened = await RunStore.open(cwd, "run");
    await reopened.event("second", {});
    await reopened.flush();
    const lines = (await readFile(path.join(reopened.runDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines.map(line => line.sequence)).toEqual([1, 2]);
  });

  it("leases a run exclusively and only releases its own token", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-store-"));
    directories.push(cwd);
    const store = new RunStore(cwd, "run");
    const lease = await store.acquireLease();
    await expect(store.acquireLease()).rejects.toThrow("already leased");
    expect(await lease.release()).toBe(true);
    expect(await lease.release()).toBe(false);
    const next = await store.acquireLease();
    expect(next.token).not.toBe(lease.token);
    await next.release();
  });

  it("recovers a demonstrably stale same-host lease", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-store-"));
    directories.push(cwd);
    const store = new RunStore(cwd, "run");
    await store.init();
    await writeFile(path.join(store.runDir, "run-lease.json"), JSON.stringify({
      token: "stale",
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: new Date(0).toISOString()
    }));
    const lease = await store.acquireLease({ recoverStale: true });
    expect(lease.token).not.toBe("stale");
    expect(await lease.release()).toBe(true);
  });
});
