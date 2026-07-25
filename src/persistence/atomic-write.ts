import { randomUUID } from "node:crypto";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const RENAME_RETRIES = 5;
const RENAME_BASE_DELAY_MS = 100;

export async function atomicReplace(target: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(target);
  const name = path.basename(target);
  const temporary = path.join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content);
    try {
      await renameWithRetry(temporary, target);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code === "EPERM") {
        await copyFile(temporary, target).catch(() => { throw renameError; });
      } else {
        throw renameError;
      }
    }
    await rm(temporary, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(oldPath: string, newPath: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(oldPath, newPath);
      return;
    } catch (error) {
      if (attempt <= RENAME_RETRIES && (error as NodeJS.ErrnoException).code === "EPERM") {
        await new Promise(r => setTimeout(r, RENAME_BASE_DELAY_MS * Math.pow(2, attempt - 1)));
        continue;
      }
      throw error;
    }
  }
}
