import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { CheckDiscoveryResult, PackageManager } from "../types.js";

const SCRIPT_ORDER = ["test", "typecheck", "lint", "build"] as const;
const LOCKFILES: Record<PackageManager, string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"]
};

export async function discoverProjectChecks(cwd: string): Promise<CheckDiscoveryResult> {
  const diagnostics: string[] = [];
  const packageFile = path.join(cwd, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageFile, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { commands: [], scripts: [], diagnostics: [`No package.json found in ${cwd}`] };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { commands: [], scripts: [], diagnostics: [`Could not parse ${packageFile}: ${detail}`] };
  }
  if (!isRecord(parsed)) {
    return { commands: [], scripts: [], diagnostics: [`${packageFile} must contain a JSON object`] };
  }

  const packageManager = await detectPackageManager(cwd, parsed.packageManager, diagnostics);
  if (!packageManager) return { commands: [], scripts: [], diagnostics };
  const scriptsValue = parsed.scripts;
  if (!isRecord(scriptsValue)) {
    return { packageManager, commands: [], scripts: [], diagnostics: [...diagnostics, "package.json has no scripts object"] };
  }

  const commands: string[] = [];
  const scripts: string[] = [];
  for (const scriptName of SCRIPT_ORDER) {
    const script = scriptsValue[scriptName];
    if (typeof script !== "string" || !script.trim()) continue;
    if (scriptName === "test" && isPlaceholderTest(script)) {
      diagnostics.push("Skipped the default failing test placeholder");
      continue;
    }
    scripts.push(scriptName);
    commands.push(buildCommand(packageManager, scriptName, script));
  }
  if (commands.length === 0) diagnostics.push("No supported test, typecheck, lint, or build scripts were found");
  return { packageManager, commands, scripts, diagnostics };
}

async function detectPackageManager(
  cwd: string,
  declared: unknown,
  diagnostics: string[]
): Promise<PackageManager | undefined> {
  if (declared !== undefined) {
    if (typeof declared !== "string") {
      diagnostics.push("packageManager must be a string when present");
      return undefined;
    }
    const match = /^(npm|pnpm|yarn|bun)(?:@|$)/i.exec(declared.trim());
    if (!match) {
      diagnostics.push(`Unsupported packageManager value: ${declared}`);
      return undefined;
    }
    return match[1].toLowerCase() as PackageManager;
  }

  const detected: PackageManager[] = [];
  for (const manager of Object.keys(LOCKFILES) as PackageManager[]) {
    if (await anyExists(cwd, LOCKFILES[manager])) detected.push(manager);
  }
  if (detected.length > 1) {
    diagnostics.push(`Conflicting package-manager lockfiles found: ${detected.join(", ")}`);
    return undefined;
  }
  return detected[0] ?? "npm";
}

function buildCommand(manager: PackageManager, scriptName: (typeof SCRIPT_ORDER)[number], script: string): string {
  let command: string;
  if (manager === "bun") command = `bun run ${scriptName}`;
  else if (scriptName === "test") command = `${manager} test`;
  else command = `${manager} run ${scriptName}`;

  if (scriptName === "test" && /(?:^|\s)react-scripts\s+test(?:\s|$)/i.test(script)) {
    const flags: string[] = [];
    if (!script.includes("--watchAll")) flags.push("--watchAll=false");
    if (!script.includes("--passWithNoTests")) flags.push("--passWithNoTests");
    if (flags.length > 0) {
      const separator = manager === "yarn" ? " " : " -- ";
      command += separator + flags.join(" ");
    }
  }
  return command;
}

function isPlaceholderTest(script: string): boolean {
  return /no test specified/i.test(script) && /exit\s+1/i.test(script);
}

async function anyExists(cwd: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    try {
      await access(path.join(cwd, name));
      return true;
    } catch {
      // Try the next lockfile alias.
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
