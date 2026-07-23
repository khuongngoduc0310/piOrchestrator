export function consumeScopeRevision(current: number, limit: number, context: string): number {
  if (!Number.isSafeInteger(current) || current < 0) throw new Error("Scope revision count is invalid");
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Scope revision limit is invalid");
  if (current >= limit) throw new Error(`Failure scope revision limit reached${context ? ` ${context}` : ""}`);
  return current + 1;
}
