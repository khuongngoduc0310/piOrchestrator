const MAX_REPOSITORY_PATH_BYTES = 400;

export class RepositoryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryPathError";
  }
}

export function normalizeRepositoryPath(value: string, allowTrailingSlash = false): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RepositoryPathError("must not be empty");
  if (Buffer.byteLength(trimmed, "utf8") > MAX_REPOSITORY_PATH_BYTES) {
    throw new RepositoryPathError(`must not exceed ${MAX_REPOSITORY_PATH_BYTES} bytes`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new RepositoryPathError("must not contain control characters");

  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized)) {
    throw new RepositoryPathError("must be repository-relative");
  }

  const withoutTrailingSlash = allowTrailingSlash ? normalized.replace(/\/+$/, "") : normalized;
  if (!withoutTrailingSlash || (!allowTrailingSlash && normalized.endsWith("/"))) {
    throw new RepositoryPathError("must identify a file or directory without a trailing slash");
  }
  const segments = withoutTrailingSlash.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new RepositoryPathError("must not contain empty, . or .. path segments");
  }
  return segments.join("/");
}
