import { describe, expect, it, mock } from 'bun:test';

const executableResolver = mock(async () => '/custom/bin/git');
const execFile = mock((command, args, _options, callback) => {
  if (args.includes('sparse-checkout')) {
    callback(Object.assign(new Error('sparse checkout unavailable'), { stderr: 'unsupported' }));
    return;
  }
  if (args.includes('ls-tree')) {
    callback(null, { stdout: 'skills/example/SKILL.md\n', stderr: '' });
    return;
  }
  if (args.includes('show')) {
    callback(null, { stdout: '---\ndescription: Example skill\n---\n', stderr: '' });
    return;
  }
  callback(null, { stdout: '', stderr: '' });
});

mock.module('child_process', () => ({ execFile }));
mock.module('./gitService', () => ({ getGitExecutablePath: executableResolver }));
mock.module('./git-execution-runtime', () => ({
  gitExecutionRuntime: {
    coordinator: {
      runClone: async (_options, task) => task({ releaseNetwork: mock() }),
    },
  },
}));

const { scanSkillsRepository } = await import('./skillsCatalog');

describe('VS Code skills catalog Git executable selection', () => {
  it('uses the configured Git executable for availability and repository reads', async () => {
    const result = await scanSkillsRepository({
      source: 'example/skills',
      defaultSubpath: 'skills',
    });

    expect(result).toMatchObject({
      ok: true,
      items: [{ skillName: 'example', description: 'Example skill' }],
    });
    expect(executableResolver).toHaveBeenCalled();
    expect(execFile).toHaveBeenCalled();
    expect(execFile.mock.calls.every(([command]) => command === '/custom/bin/git')).toBe(true);
    expect(execFile.mock.calls[0]?.[1]).toEqual(['--version']);
  });
});
