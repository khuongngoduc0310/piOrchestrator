import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicReplace } from "./atomic-write.js";

const { mockRename, mockCopyFile } = vi.hoisted(() => ({
  mockRename: vi.fn<(...args: string[]) => Promise<void>>(),
  mockCopyFile: vi.fn<(...args: string[]) => Promise<void>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: mockRename,
    copyFile: mockCopyFile,
  };
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

beforeEach(() => {
  mockRename.mockReset();
  mockCopyFile.mockReset();
});

describe("atomicReplace", () => {
  it("writes content to target on success", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-orch-atomic-"));
    directories.push(dir);
    const target = path.join(dir, "test.json");

    mockRename.mockImplementation(async (oldPath, newPath) => {
      const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      await real.rename(oldPath, newPath);
    });

    await atomicReplace(target, '{"ok":true}\n');

    const content = await readFile(target, "utf8");
    expect(content).toBe('{"ok":true}\n');
  });

  it("retries rename on EPERM then succeeds", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-orch-atomic-"));
    directories.push(dir);
    const target = path.join(dir, "test.json");

    let callCount = 0;
    mockRename.mockImplementation(async (oldPath, newPath) => {
      callCount++;
      if (callCount <= 2) {
        const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      await real.rename(oldPath, newPath);
    });

    await atomicReplace(target, '{"retried":true}\n');

    const content = await readFile(target, "utf8");
    expect(content).toBe('{"retried":true}\n');
    expect(callCount).toBe(3);
  });

  it("falls back to copyFile when rename always fails with EPERM", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-orch-atomic-"));
    directories.push(dir);
    const target = path.join(dir, "test.json");

    const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
    err.code = "EPERM";
    mockRename.mockRejectedValue(err);

    mockCopyFile.mockImplementation(async (src, dest) => {
      const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      await real.copyFile(src, dest);
    });

    await atomicReplace(target, '{"fallback":true}\n');

    const content = await readFile(target, "utf8");
    expect(content).toBe('{"fallback":true}\n');
    expect(mockCopyFile).toHaveBeenCalledOnce();
  });

  it("throws original rename error when copyFile also fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-orch-atomic-"));
    directories.push(dir);
    const target = path.join(dir, "test.json");

    const renameErr = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
    renameErr.code = "EPERM";
    mockRename.mockRejectedValue(renameErr);

    const copyErr = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    copyErr.code = "EACCES";
    mockCopyFile.mockRejectedValue(copyErr);

    await expect(atomicReplace(target, '"data"')).rejects.toThrow("EPERM");
  });

  it("throws non-EPERM errors without retrying", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-orch-atomic-"));
    directories.push(dir);
    const target = path.join(dir, "test.json");

    const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    mockRename.mockRejectedValue(err);

    await expect(atomicReplace(target, '"data"')).rejects.toThrow("EACCES");
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it("cleans up temp file on failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-orch-atomic-"));
    directories.push(dir);
    const target = path.join(dir, "test.json");

    const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    mockRename.mockRejectedValue(err);

    await expect(atomicReplace(target, '"data"')).rejects.toThrow("EACCES");

    const entries = await import("node:fs/promises").then(m => m.readdir(dir));
    const tmpFiles = entries.filter(e => e.startsWith(".test.json"));
    expect(tmpFiles).toHaveLength(0);
  });
});
