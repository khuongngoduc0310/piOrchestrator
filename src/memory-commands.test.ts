import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configPath } from "./config.js";
import { loadCandidateLedger } from "./candidate-store.js";
import { handleMemoryCommand } from "./memory-commands.js";
import { getMemoryStorePath, loadMemory } from "./memory-store.js";
import { contentDigest, permanentLessonId } from "./memory-validation.js";

const testDirs: string[] = [];

async function setupRun(cwd: string, runId = "run-abc"): Promise<void> {
  const dir = path.join(path.dirname(configPath(cwd)), "runs", runId);
  await mkdir(dir, { recursive: true });
  const candidate = {
    id: "c01",
    contentDigest: contentDigest("Always verify saved provenance"),
    title: "Verify provenance",
    guidance: "Always verify saved provenance",
    scope: { roles: ["builder"], paths: [], categories: [], keywords: ["verify"] },
    evidence: [{ path: "src/main.ts", detail: "Observed during the run" }],
  };
  await writeFile(path.join(dir, "pending-candidates.json"), JSON.stringify([candidate]), "utf8");
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ runId, cwd: path.resolve(cwd), extensionVersion: "7.6.5" }), "utf8");
  await writeFile(path.join(dir, "final-checks-digest.json"), JSON.stringify({ digest: "saved-final-checks" }), "utf8");
  await writeFile(path.join(dir, "proposed-lessons-status.json"), JSON.stringify({ status: "machine_approved" }), "utf8");
}

function context(options: { trusted?: boolean; confirm?: boolean } = {}) {
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    isProjectTrusted: vi.fn(() => options.trusted ?? true),
    ui: {
      notify,
      confirm: vi.fn(async () => options.confirm ?? true),
      select: vi.fn(),
      editor: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notify };
}

afterEach(async () => {
  await Promise.all(testDirs.splice(0).flatMap(dir => {
    const store = getMemoryStorePath(dir);
    return [
      rm(store, { force: true }),
      rm(store.replace(/\.json$/, ".lock"), { recursive: true, force: true }),
      rm(dir, { recursive: true, force: true })
    ];
  }));
});

describe("memory commands", () => {
  it("applies the trust guard before parsing or file access", async () => {
    const cwd = path.join(os.tmpdir(), "does-not-need-to-exist");
    const { ctx, notify } = context({ trusted: false });
    const result = await handleMemoryCommand("approve ../../escape c01", cwd, ctx, () => false);
    expect(result).toBe("unavailable");
    expect(ctx.isProjectTrusted).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not trusted"), "warning");
  });

  it("rejects traversal and ambiguous run prefixes", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "memory-command-test-"));
    testDirs.push(cwd);
    await setupRun(cwd, "run-abc-one");
    await setupRun(cwd, "run-abc-two");
    const first = context();
    expect(await handleMemoryCommand("approve ../outside c01", cwd, first.ctx, () => false)).toBe("unavailable");
    expect(first.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid Run"), "warning");
    const second = context();
    expect(await handleMemoryCommand("approve run-abc c01", cwd, second.ctx, () => false)).toBe("unavailable");
    expect(second.notify).toHaveBeenCalledWith(expect.stringContaining("ambiguous"), "warning");
  });

  it("promotes with saved final-check and extension provenance", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "memory-command-test-"));
    testDirs.push(cwd);
    await setupRun(cwd);
    const { ctx } = context({ confirm: true });
    expect(await handleMemoryCommand("approve run-abc c01", cwd, ctx, () => false)).toBe("done");

    const memory = await loadMemory(cwd);
    expect(memory.document?.lessons).toHaveLength(1);
    expect(memory.document?.lessons[0]).toMatchObject({
      id: permanentLessonId("run-abc", "c01"),
      provenance: {
        sourceRunId: "run-abc",
        candidateId: "c01",
        finalChecksDigest: "saved-final-checks",
        extensionVersion: "7.6.5",
      },
    });
    expect((await loadCandidateLedger(cwd, "run-abc")).ledger?.candidates[0].state).toBe("promoted");
  });

  it("records decline while a cancelled confirmation remains deferred", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "memory-command-test-"));
    testDirs.push(cwd);
    await setupRun(cwd);
    const deferred = context({ confirm: false });
    expect(await handleMemoryCommand("approve run-abc c01", cwd, deferred.ctx, () => false)).toBe("done");
    expect((await loadCandidateLedger(cwd, "run-abc")).ledger?.candidates[0].state).toBe("pending");

    const declined = context({ confirm: true });
    expect(await handleMemoryCommand("decline run-abc c01", cwd, declined.ctx, () => false)).toBe("done");
    expect((await loadCandidateLedger(cwd, "run-abc")).ledger?.candidates[0].state).toBe("declined");
  });

  it("rechecks trust after confirmation before writing memory", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "memory-command-test-"));
    testDirs.push(cwd);
    await setupRun(cwd);
    const notify = vi.fn();
    const isProjectTrusted = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const ctx = {
      hasUI: true,
      isProjectTrusted,
      ui: { notify, confirm: vi.fn(async () => true), select: vi.fn(), editor: vi.fn() }
    } as unknown as ExtensionCommandContext;
    expect(await handleMemoryCommand("approve run-abc c01", cwd, ctx, () => false)).toBe("unavailable");
    expect((await loadMemory(cwd)).document).toBeNull();
    expect((await loadCandidateLedger(cwd, "run-abc")).ledger?.candidates[0].state).toBe("pending");
  });
});
