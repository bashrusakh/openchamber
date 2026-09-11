export type GitHubItemKind = 'issue' | 'pr';

const URL_NUMBER_PATTERNS = {
  issue: /\/issues\/(\d+)(?:\b|\/|$)/i,
  pr: /\/pull\/(\d+)(?:\b|\/|$)/i,
} satisfies Record<GitHubItemKind, RegExp>;

/**
 * Detect a direct GitHub issue/PR reference: a bare number, `#number`, or a
 * GitHub issue/PR URL. Returns the number, or null when the value is free text
 * (including mixed text+number queries like `123 bug`).
 */
export const parseGitHubNumber = (value: string, kind: GitHubItemKind): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(URL_NUMBER_PATTERNS[kind]);
  if (urlMatch) {
    const parsed = Number(urlMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const hashMatch = trimmed.match(/^#?(\d+)$/);
  if (hashMatch) {
    const parsed = Number(hashMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
};
