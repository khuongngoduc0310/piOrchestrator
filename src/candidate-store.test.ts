import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath } from "./config.js";
import {
  createCandidateLedger,
  loadCandidateLedger,
  saveCandidateLedger,
  setCandidateState,
} from "./candidate-store.js";
import type { CandidateLesson } from "./memory-types.js";
import { contentDigest } from "./memory-validation.js";

const testDirs: string[] = [];

async function tempProject(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "candidate-ledger-test-"));
  testDirs.push(cwd);
  return cwd;
}

function candidate(id = "c01"): CandidateLesson {
  return {
    id,
    contentDigest: contentDigest(`guidance ${id}`),
    title: `Candidate ${id}`,
    guidance: `guidance ${id}`,
    scope: { roles: ["builder"], paths: ["src"], categories: ["testing"], keywords: ["verify"] },
    evidence: [{ path: "src/main.ts", detail: "Observed in the run" }],
  };
}

async function runDir(cwd: string, runId: string): Promise<string> {
  const dir = path.join(path.dirname(configPath(cwd)), "runs", runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("candidate-store", () => {
  it("validates and persists legal lifecycle transitions", async () => {
    const cwd = await tempProject();
    await runDir(cwd, "run-abc");
    let ledger = createCandidateLedger(cwd, "run-abc", [candidate()], "checks-123", "1.2.3");
    ledger = setCandidateState(ledger, "c01", "machine_approved");
    ledger = setCandidateState(ledger, "c01", "pending");
    ledger = setCandidateState(ledger, "c01", "promotion_pending");
    ledger = setCandidateState(ledger, "c01", "promoted");
    await saveCandidateLedger(cwd, ledger);

    const loaded = await loadCandidateLedger(cwd, "run-abc");
    expect(loaded.error).toBeUndefined();
    expect(loaded.ledger?.candidates[0].state).toBe("promoted");
    expect(loaded.ledger?.candidates[0].transitions).toHaveLength(4);
  });

  it("rejects illegal state transitions", () => {
    let ledger = createCandidateLedger(".", "run-abc", [candidate()], "checks-123", "1.2.3");
    ledger = setCandidateState(ledger, "c01", "machine_approved");
    ledger = setCandidateState(ledger, "c01", "pending");
    expect(() => setCandidateState(ledger, "c01", "machine_rejected")).toThrow("illegal candidate transition");
  });

  it("synthesizes a pending ledger with saved provenance from current run artifacts", async () => {
    const cwd = await tempProject();
    const dir = await runDir(cwd, "run-abc");
    await writeFile(path.join(dir, "pending-candidates.json"), JSON.stringify([candidate()]), "utf8");
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ runId: "run-abc", cwd: path.resolve(cwd), extensionVersion: "9.8.7" }), "utf8");
    await writeFile(path.join(dir, "final-checks-digest.json"), JSON.stringify({ digest: "saved-checks" }), "utf8");
    await writeFile(path.join(dir, "proposed-lessons-status.json"), JSON.stringify({ status: "machine_approved" }), "utf8");

    const loaded = await loadCandidateLedger(cwd, "run-abc");
    expect(loaded.ledger?.finalChecksDigest).toBe("saved-checks");
    expect(loaded.ledger?.extensionVersion).toBe("9.8.7");
    expect(loaded.ledger?.candidates[0].state).toBe("pending");
  });

  it("rejects malformed and project-mismatched ledgers", async () => {
    const cwd = await tempProject();
    const dir = await runDir(cwd, "run-abc");
    await writeFile(path.join(dir, "candidate-ledger.json"), "{bad", "utf8");
    expect((await loadCandidateLedger(cwd, "run-abc")).error).toContain("malformed");

    const mismatched = createCandidateLedger(`${cwd}-other`, "run-abc", [candidate()], "checks", "1.0.0");
    await writeFile(path.join(dir, "candidate-ledger.json"), JSON.stringify(mismatched), "utf8");
    expect((await loadCandidateLedger(cwd, "run-abc")).error).toContain("projectPath mismatch");
  });

  it("rejects traversal run IDs before constructing a path", async () => {
    const cwd = await tempProject();
    const loaded = await loadCandidateLedger(cwd, "../outside");
    expect(loaded.ledger).toBeNull();
    expect(loaded.error).toContain("id must be alphanumeric");
  });

  it("rejects a stale concurrent ledger replacement", async () => {
    const cwd = await tempProject();
    await runDir(cwd, "run-abc");
    let initial = createCandidateLedger(cwd, "run-abc", [candidate()], "checks-123", "1.2.3");
    initial = await saveCandidateLedger(cwd, initial);
    const first = (await loadCandidateLedger(cwd, "run-abc")).ledger!;
    const second = structuredClone(first);
    const approved = setCandidateState(first, "c01", "machine_approved");
    await saveCandidateLedger(cwd, approved);
    const stale = setCandidateState(second, "c01", "machine_approved");
    await expect(saveCandidateLedger(cwd, stale)).rejects.toThrow("revision mismatch");
  });
});
