import { normalizeRepositoryPath, RepositoryPathError } from "./path-validation.js";

export class ValidationError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ValidationError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError(path, "expected an object");
  return value;
}

export function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new ValidationError(path, "expected a string");
  if (!allowEmpty && !value.trim()) throw new ValidationError(path, "must not be empty");
  return value;
}

export function boundedString(value: unknown, path: string, maxBytes: number): string {
  const result = string(value, path);
  if (Buffer.byteLength(result, "utf8") > maxBytes) throw new ValidationError(path, `must not exceed ${maxBytes} bytes`);
  return result;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(path, "expected a boolean");
  return value;
}

export function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError(path, "expected a finite integer");
  }
  if (value < minimum) throw new ValidationError(path, `must be >= ${minimum}`);
  return value;
}

export function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  const result = integer(value, path, minimum);
  if (result > maximum) throw new ValidationError(path, `must be <= ${maximum}`);
  return result;
}

export function array<T>(value: unknown, path: string, reader: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new ValidationError(path, "expected an array");
  return value.map((item, index) => reader(item, `${path}[${index}]`));
}

export function strings(value: unknown, path: string): string[] {
  return array(value, path, (item, itemPath) => string(item, itemPath));
}

export function uniqueStrings(value: unknown, path: string, maximum = 20): string[] {
  const result = strings(value, path);
  if (result.length > maximum) throw new ValidationError(path, `must not contain more than ${maximum} items`);
  const seen = new Set<string>();
  for (let index = 0; index < result.length; index++) {
    if (seen.has(result[index])) throw new ValidationError(`${path}[${index}]`, "must not contain duplicates");
    seen.add(result[index]);
  }
  return result;
}

export function repositoryPath(value: unknown, path: string, allowTrailingSlash = false): string {
  const result = string(value, path);
  try {
    return normalizeRepositoryPath(result, allowTrailingSlash);
  } catch (error) {
    if (error instanceof RepositoryPathError) throw new ValidationError(path, error.message);
    throw error;
  }
}

export function repositoryPaths(value: unknown, path: string, allowTrailingSlash = false): string[] {
  return array(value, path, (item, itemPath) => repositoryPath(item, itemPath, allowTrailingSlash));
}

export function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(path, `expected one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseStructuredJson(text: string, label = "output"): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new ValidationError(label, "assistant returned empty output");

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (rawError) {
    const markers = trimmed.match(/```/g)?.length ?? 0;
    const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
    if (markers === 2 && fenced) {
      try {
        return JSON.parse(fenced[1].trim()) as unknown;
      } catch (fencedError) {
        const detail = fencedError instanceof Error ? fencedError.message : String(fencedError);
        throw new ValidationError(label, `invalid JSON (${detail})`);
      }
    }
    if (markers > 0) throw new ValidationError(label, "malformed JSON fence");
    const detail = rawError instanceof Error ? rawError.message : String(rawError);
    throw new ValidationError(label, `invalid JSON (${detail})`);
  }
}
