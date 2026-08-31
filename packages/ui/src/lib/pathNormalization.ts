/**
 * Normalize a directory path for consistent comparison.
 *
 * Handles Windows-specific path quirks:
 * - Converts backslashes to forward slashes
 * - Uppercases lowercase Windows drive letters (e.g., "c:\\" → "C:\\")
 * - Trims trailing slashes (except for the root "/")
 *
 * Returns null for non-string inputs, null/undefined, empty strings,
 * whitespace-only strings, and paths that consist only of slashes
 * (e.g. "\\", "\\\\", "///").
 *
 * The drive letter regex is anchored (^([a-z]):) and matches only a
 * single lowercase letter, so it never affects multi-character tokens
 * (e.g., "abc:def"), URLs, or Windows `\\?\` device paths.
 */
export const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const replaced = trimmed
    .replace(/\\/g, "/")
    .replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ":");

  if (replaced === "/") return "/";
  const stripped = replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced;
  return stripped || null;
};

const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:|\/\/)/;

/**
 * Canonicalize a normalized path for identity keys and comparisons.
 *
 * Display and authoritative paths must retain their component casing. Only
 * identity boundaries apply Windows' case-insensitive matching rules; POSIX
 * paths remain case-sensitive.
 */
export const canonicalizePathIdentity = (value?: string | null): string | null => {
  const normalized = normalizePath(value);
  if (!normalized) return null;
  return WINDOWS_PATH_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
};
