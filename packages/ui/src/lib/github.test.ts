import { describe, expect, test } from 'bun:test';
import { parseGitHubNumber } from './github';

describe('parseGitHubNumber', () => {
  describe('issue kind', () => {
    test('detects a bare number', () => {
      expect(parseGitHubNumber('123', 'issue')).toBe(123);
    });

    test('detects a #number reference', () => {
      expect(parseGitHubNumber('#123', 'issue')).toBe(123);
    });

    test('detects a GitHub issue URL', () => {
      expect(parseGitHubNumber('https://github.com/acme/app/issues/123', 'issue')).toBe(123);
      expect(parseGitHubNumber('https://github.com/acme/app/issues/123#issuecomment-456', 'issue')).toBe(123);
    });

    test('rejects free text and mixed text+number', () => {
      expect(parseGitHubNumber('123 bug', 'issue')).toBeNull();
      expect(parseGitHubNumber('bug 123', 'issue')).toBeNull();
      expect(parseGitHubNumber('search query', 'issue')).toBeNull();
      expect(parseGitHubNumber('', 'issue')).toBeNull();
    });

    test('rejects a pull URL for the issue kind', () => {
      expect(parseGitHubNumber('https://github.com/acme/app/pull/123', 'issue')).toBeNull();
    });
  });

  describe('pr kind', () => {
    test('detects a bare number', () => {
      expect(parseGitHubNumber('456', 'pr')).toBe(456);
    });

    test('detects a #number reference', () => {
      expect(parseGitHubNumber('#456', 'pr')).toBe(456);
    });

    test('detects a GitHub pull request URL', () => {
      expect(parseGitHubNumber('https://github.com/acme/app/pull/456', 'pr')).toBe(456);
      expect(parseGitHubNumber('https://github.com/acme/app/pull/456/files', 'pr')).toBe(456);
    });

    test('rejects free text and mixed text+number', () => {
      expect(parseGitHubNumber('456 bug', 'pr')).toBeNull();
      expect(parseGitHubNumber('bug 456', 'pr')).toBeNull();
      expect(parseGitHubNumber('search query', 'pr')).toBeNull();
      expect(parseGitHubNumber('', 'pr')).toBeNull();
    });

    test('rejects an issue URL for the pr kind', () => {
      expect(parseGitHubNumber('https://github.com/acme/app/issues/456', 'pr')).toBeNull();
    });
  });

  test('rejects zero and negative numbers', () => {
    expect(parseGitHubNumber('0', 'issue')).toBeNull();
    expect(parseGitHubNumber('-5', 'issue')).toBeNull();
    expect(parseGitHubNumber('#0', 'pr')).toBeNull();
  });
});
