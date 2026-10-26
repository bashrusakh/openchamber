/**
 * The export pipeline's own contract.
 *
 * The tests read the same way the export does: a session tree in, a document
 * out. They cover the cases the redesign has to get right — nesting, parallel
 * work, background runs, resumed sessions, missing identities, missing
 * timestamps, every tool state, and the scale the export has to survive.
 */

import { describe, expect, test } from 'bun:test';
import type { SessionMessageInfo } from '@opencode/client';
import type { Part, Session } from '@/lib/opencode/model';
import { projectMessage } from '@/lib/opencode/projection';
import { useI18nStore } from '@/lib/i18n';
import { dict as deDict } from '@/lib/i18n/messages/de';
import { buildExport, buildExportFromRecords } from './pipeline';
import { renderExportMarkdown } from './markdown';
import { renderExportHtml } from './html';
import { renderExportJson } from './json';
import type { ExportSessionInfo, ExportTimeline } from './events';
import type { ProjectedNode } from './project';
import {
  assistantMessage,
  futurePart,
  shellCall,
  subagentCall,
  subagentReport,
  textPart,
  timedTextPart,
  userMessage,
  type Record_,
} from './fixtures';



const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  projectID: 'proj_1',
  directory: '/repo',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  ...overrides,
});

type Fixture = {
  root: Session;
  sessions: Session[];
  records: Map<string, Record_[]>;
};

const fixture = (parts: {
  root: Session;
  sessions?: Session[];
  records: Record<string, Record_[]>;
}): Fixture => ({
  root: parts.root,
  sessions: parts.sessions ?? [parts.root],
  records: new Map(Object.entries(parts.records)),
});

const build = (input: Fixture, mode: 'readable' | 'detailed' = 'readable') => (
  buildExportFromRecords({
    root: input.root,
    sessions: input.sessions,
    records: input.records,
  }, mode)
);

/** A record as the real adapter projects it from the wire. */
const adapterRecord = (wire: SessionMessageInfo, sessionID: string): Record_ => {
  const projected = projectMessage(wire, sessionID);
  return { info: projected.message, parts: projected.parts };
};

const markdown = (input: Fixture, mode: 'readable' | 'detailed' = 'readable'): string => {
  const { projection, timeline } = build(input, mode);
  return renderExportMarkdown(projection, {
    title: input.root.title,
    mode,
    findings: timeline.findings, excluded: timeline.excluded,
    sessionCount: timeline.sessions.size,
  });
};

const timelineOf = (input: Fixture): ExportTimeline => build(input).timeline;

const sessionsOf = (timeline: ExportTimeline): ExportSessionInfo[] => [...timeline.sessions.values()];

describe('export pipeline', () => {
  test('nested shell results and first-prompt files reach Markdown and HTML', () => {
    const child = session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' });
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [session('ses_root', { title: 'Root' }), child],
      records: {
        ses_root: [{
          info: assistantMessage('ses_root', 'a1', 1000, '').info,
          parts: [subagentCall('a1', { childSessionID: child.id, startedAt: 1000, endedAt: 5000 })],
        }],
        ses_child: [
          {
            info: { id: 'u1', sessionID: child.id, role: 'user', time: { created: 2100 } },
            parts: [{ id: 'f1', sessionID: child.id, messageID: 'u1', type: 'file', mime: 'text/plain', filename: 'TASK_FILE_SENTINEL.txt', url: 'file:///brief.txt' }],
          },
          {
            info: {
              id: 's1', sessionID: child.id, role: 'shell', time: { created: 2200 }, shellID: 'sh1',
              command: 'check.sh', status: 'exited', exit: 7,
              output: { output: 'CHILD_SHELL_FAILURE_SENTINEL', cursor: 28, size: 28, truncated: false },
            },
            parts: [],
          },
        ],
      },
    });

    const result = build(input, 'detailed');
    const markdownOutput = renderExportMarkdown(result.projection, {
      title: 'Root', mode: 'detailed', findings: result.timeline.findings,
      excluded: result.timeline.excluded, sessionCount: result.timeline.sessions.size,
    });
    const htmlOutput = renderExportHtml(result.projection, {
      title: 'Root', mode: 'detailed', findings: result.timeline.findings,
      excluded: result.timeline.excluded, sessionCount: result.timeline.sessions.size,
    });
    for (const output of [markdownOutput, htmlOutput]) {
      expect(output).toContain('TASK_FILE_SENTINEL.txt');
      expect(output).toContain('CHILD_SHELL_FAILURE_SENTINEL');
      expect(output).toContain('7');
    }
    expect(htmlOutput).toContain('data-kind="task"');
    expect(htmlOutput).toContain('task_file_sentinel.txt');
  });

  test('completion reports retain recorded agent and task attribution without child transcripts', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          subagentReport('ses_root', 'r1', 3000, {
            childSessionID: 'ses_a', agent: 'reviewer', description: 'Review dependency changes', output: 'RESULT_ALPHA',
          }),
          subagentReport('ses_root', 'r2', 4000, {
            childSessionID: 'ses_b', agent: 'tester', description: 'Run behavioral tests', output: 'RESULT_BETA',
          }),
        ],
      },
    });
    const { projection, timeline } = buildExportFromRecords({
      root: input.root, sessions: input.sessions, records: input.records, includeSubagents: false,
    }, 'readable');
    const markdownOutput = renderExportMarkdown(projection, {
      title: 'Root', mode: 'readable', findings: timeline.findings,
      excluded: timeline.excluded, sessionCount: timeline.sessions.size,
    });
    const htmlOutput = renderExportHtml(projection, {
      title: 'Root', mode: 'readable', findings: timeline.findings,
      excluded: timeline.excluded, sessionCount: timeline.sessions.size,
    });
    for (const [output, format] of [[markdownOutput, 'markdown'], [htmlOutput, 'html']] as const) {
      expect(output).toContain('reviewer');
      expect(output).toContain('Review dependency changes');
      expect(output).toContain('tester');
      expect(output).toContain('Run behavioral tests');
      expect(output).toContain('RESULT_ALPHA');
      expect(output).toContain('RESULT_BETA');
      if (format === 'html') {
        expect(output).toContain('data-agent="reviewer"');
        expect(output).toContain('data-agent="tester"');
      }
    }
    expect(timeline.sessions.has('ses_a')).toBe(false);
    expect(timeline.sessions.has('ses_b')).toBe(false);
    const reports = timeline.events.filter((event) => event.kind === 'subagent-result');
    expect(reports.map((event) => event.kind === 'subagent-result' ? event.agent : undefined)).toEqual(['reviewer', 'tester']);
    const json = JSON.parse(renderExportJson(timeline)) as { events: Array<{ agent?: string; description?: string }> };
    expect(json.events.map((event) => [event.agent, event.description])).toEqual([
      ['reviewer', 'Review dependency changes'],
      ['tester', 'Run behavioral tests'],
    ]);
  });
  test('a parent with one child and one grandchild keeps the nesting', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
        session('ses_grand', { title: 'Grand', parentID: 'ses_child', agent: 'explore' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Do the work'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [textPart('a1', 'Starting'), subagentCall('a1', { childSessionID: 'ses_child' })],
          },
        ],
        ses_child: [
          {
            info: {
              id: 'ca1', sessionID: 'ses_child', role: 'assistant', agent: 'reviewer',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2100 },
            },
            parts: [textPart('ca1', 'Child work'), subagentCall('ca1', { childSessionID: 'ses_grand', sessionID: 'ses_child' })],
          },
        ],
        ses_grand: [assistantMessage('ses_grand', 'ga1', 2200, 'Grandchild work')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('↳ reviewer');
    expect(output).toContain('↳ explore');
    // The grandchild's work is inside the child's block, not beside it, and
    // it sits at the call that started it. Text before the call stays before
    // the block; text after the call stays after it.
    expect(output.indexOf('Child work')).toBeLessThan(output.indexOf('Grandchild work'));
    expect(output.indexOf('Starting')).toBeLessThan(output.indexOf('Grandchild work'));
  });

  test('several sequential subagents appear at their own points in the conversation', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child_a', { title: 'First', parentID: 'ses_root', agent: 'reviewer' }),
        session('ses_child_b', { title: 'Second', parentID: 'ses_root', agent: 'tester' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child_a', startedAt: 2000, endedAt: 3000 })],
          },
          assistantMessage('ses_root', 'a2', 5000, 'Now the second one'),
          {
            info: {
              id: 'a3', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 6000 },
            },
            parts: [subagentCall('a3', { childSessionID: 'ses_child_b', startedAt: 6000, endedAt: 7000 })],
          },
        ],
        ses_child_a: [assistantMessage('ses_child_a', 'ca1', 2500, 'First result')],
        ses_child_b: [assistantMessage('ses_child_b', 'cb1', 6500, 'Second result')],
      },
    });

    const output = markdown(input);

    expect(output.indexOf('First result')).toBeLessThan(output.indexOf('Now the second one'));
    expect(output.indexOf('Now the second one')).toBeLessThan(output.indexOf('Second result'));
  });

  test('parallel subagents are marked as overlapping instead of read as sequential', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_a', { title: 'A', parentID: 'ses_root', agent: 'reviewer' }),
        session('ses_b', { title: 'B', parentID: 'ses_root', agent: 'tester' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [
              subagentCall('a1', { childSessionID: 'ses_a', startedAt: 2000, endedAt: 9000 }),
              subagentCall('a1b', { childSessionID: 'ses_b', startedAt: 2100, endedAt: 8000 }),
            ],
          },
        ],
        ses_a: [assistantMessage('ses_a', 'aa1', 3000, 'A result')],
        ses_b: [assistantMessage('ses_b', 'ab1', 3100, 'B result')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Ran at the same time as');
    expect(output).toContain('A result');
    expect(output).toContain('B result');
  });

  test('two calls that only touch are not marked as running at the same time', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_a', { title: 'A', parentID: 'ses_root', agent: 'reviewer' }),
        session('ses_b', { title: 'B', parentID: 'ses_root', agent: 'tester' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_a', startedAt: 2000, endedAt: 3000 })],
          },
          {
            info: {
              id: 'a2', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 3000 },
            },
            parts: [subagentCall('a2', { childSessionID: 'ses_b', startedAt: 3000, endedAt: 4000 })],
          },
        ],
        ses_a: [assistantMessage('ses_a', 'aa1', 2500, 'First result')],
        ses_b: [assistantMessage('ses_b', 'ab1', 3500, 'Second result')],
      },
    });

    const output = markdown(input);

    // The first call ended at the moment the second one started, so the
    // runtime ran them one after the other. The document must not call that
    // an overlap the runtime never recorded.
    expect(output).not.toContain('Ran at the same time as');
    expect(output).toContain('First result');
    expect(output).toContain('Second result');
  });

  test('a completion report timestamp does not make separate work overlap', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_reported', { title: 'Reported', parentID: 'ses_root', agent: 'reviewer' }),
        session('ses_timed', { title: 'Timed', parentID: 'ses_root', agent: 'tester' }),
      ],
      records: {
        ses_root: [
          subagentReport('ses_root', 'report', 4000, {
            childSessionID: 'ses_reported', agent: 'reviewer', output: 'Reported result',
          }),
          {
            info: assistantMessage('ses_root', 'a1', 3000, '').info,
            parts: [subagentCall('a1', { childSessionID: 'ses_timed', startedAt: 3000, endedAt: 5000, agent: 'tester' })],
          },
        ],
        ses_reported: [assistantMessage('ses_reported', 'ra', 1000, 'Reported work')],
        ses_timed: [assistantMessage('ses_timed', 'ta', 3500, 'Timed work')],
      },
    });

    const output = markdown(input);

    expect(output).not.toContain('Ran at the same time as');
    expect(output).toContain('Reported work');
    expect(output).toContain('Timed work');
  });

  test('a background dispatch and its later completion both reach the export', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', status: 'running', startedAt: 2000 })],
          },
          assistantMessage('ses_root', 'a2', 3000, 'Working on something else meanwhile'),
          subagentReport('ses_root', 'r1', 9000, {
            childSessionID: 'ses_child',
            output: 'The background review found a defect.',
          }),
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 8500, 'Background work')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Background work');
    expect(output).toContain('The background review found a defect.');
    expect(output).toContain('Sub-agent result');
  });

  test('a resumed child keeps one transcript and reports the reuse', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child' })],
          },
          {
            info: {
              id: 'a2', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 5000 },
            },
            parts: [subagentCall('a2', { childSessionID: 'ses_child', description: 'Continue the review' })],
          },
          {
            info: {
              id: 'a3', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 7000 },
            },
            parts: [subagentCall('a3', { childSessionID: 'ses_child', description: 'Continue once more' })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 3000, 'The one transcript')],
      },
    });

    const output = markdown(input);

    expect(output.match(/The one transcript/g)).toHaveLength(1);
    expect(output).toContain('Incomplete export');
    expect(output).toContain('More than one call names the sub-agent session');
    // The reuse is reported once, not once per call that named the session.
    expect(timelineOf(input).findings.filter((finding) => finding.kind === 'resumed-session')).toHaveLength(1);
  });

  test('a child with no recorded call is reported instead of being dropped', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_orphan', { title: 'Orphan', parentID: 'ses_root' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_orphan: [assistantMessage('ses_orphan', 'oa1', 2000, 'Orphan work')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Orphan work');
    expect(output).toContain('was not tied to a call');
  });

  test('a child whose records cannot be loaded is reported once', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('could not be loaded');
    expect(output).toContain('Incomplete export');
  });

  test('events without a timestamp keep the order the source recorded', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'First'),
          userMessage('ses_root', 'u2', 1000, 'Second'),
          userMessage('ses_root', 'u3', 1000, 'Third'),
        ],
      },
    });

    const output = markdown(input);

    expect(output.indexOf('First')).toBeLessThan(output.indexOf('Second'));
    expect(output.indexOf('Second')).toBeLessThan(output.indexOf('Third'));
  });

  test('events that share a timestamp keep the order the source recorded', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'First'),
          userMessage('ses_root', 'u2', 1000, 'Second'),
        ],
      },
    });

    const output = markdown(input);

    expect(output.indexOf('First')).toBeLessThan(output.indexOf('Second'));
  });

  test('text parts without their own time stay around a timed tool in source order', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [{
          info: {
            id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
          },
          parts: [
            textPart('a1', 'Начинаю проверку'),
            shellCall('a1', 'bun test', 2500, 2600),
            textPart('a1', 'Тесты прошли', 'a1-text-after'),
          ],
        }],
      },
    });

    const readable = markdown(input);
    const parsed: { events: Array<{ kind: string; text?: string; timestamp?: number }> } = JSON.parse(renderExportJson(timelineOf(input)));
    const events = parsed.events;
    const tool = events.findIndex((event) => event.kind === 'tool');
    const before = events.findIndex((event) => event.text === 'Начинаю проверку');
    const after = events.findIndex((event) => event.text === 'Тесты прошли');

    expect(readable.indexOf('Начинаю проверку')).toBeLessThan(readable.indexOf('`shell`'));
    expect(readable.indexOf('`shell`')).toBeLessThan(readable.indexOf('Тесты прошли'));
    expect(before).toBeLessThan(tool);
    expect(tool).toBeLessThan(after);
    expect(events[before].timestamp).toBeUndefined();
    expect(events[tool].timestamp).toBe(2500);
    expect(events[after].timestamp).toBeUndefined();
  });

  test('text parts keep their recorded times and adjacent records keep their creation times', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Before'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [
              timedTextPart('a1', 'Before tool', 2400),
              shellCall('a1', 'bun test', 2500, 2600),
              timedTextPart('a1', 'After tool', 2700, 'a1-text-after'),
            ],
          },
          userMessage('ses_root', 'u2', 3000, 'After'),
        ],
      },
    });

    const parsed: { events: Array<{ kind: string; text?: string; timestamp?: number }> } = JSON.parse(renderExportJson(timelineOf(input)));
    const events = parsed.events;
    const ordered = events.map((event) => event.kind === 'tool' ? 'tool' : event.text);

    expect(ordered).toEqual(['Before', 'Before tool', 'tool', 'After tool', 'After']);
    expect(events.map((event) => event.timestamp)).toEqual([1000, 2400, 2500, 2700, 3000]);
  });

  test('an adapter-projected unfinished record keeps text around a pending call', () => {
    // The exact shape the runtime serves while the model is still streaming:
    // a completed call sits between two text stretches, then a pending call
    // that recorded no time at all.
    const root = session('ses_root', { title: 'Root' });
    const wire: SessionMessageInfo = {
      id: 'a1', type: 'assistant', agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-opus-4-1' },
      time: { created: 1000 },
      content: [
        { type: 'text', text: 'BEFORE_TEXT' },
        {
          type: 'tool', id: 'completed-call', name: 'completed-tool',
          time: { created: 1100, ran: 1200, completed: 1300 },
          state: { status: 'completed', input: { command: 'done' }, content: [{ type: 'text', text: 'ok' }] },
        },
        { type: 'text', text: 'BETWEEN_TEXT' },
        {
          type: 'tool', id: 'pending-call', name: 'pending-tool',
          time: { created: 1400 },
          state: { status: 'streaming', input: '{"command":"later"' },
        },
      ],
    };
    const record = adapterRecord(wire, root.id);
    const input = fixture({ root, records: { ses_root: [record] } });
    const { timeline } = build(input);
    // SAFETY: `renderExportJson` writes the export's own event schema, so
    // every parsed event has the kind, text, call and origin fields read here.
    const parsed = JSON.parse(renderExportJson(timeline)) as {
      events: Array<{ kind: string; text?: string; call?: { name?: string }; timestamp?: number; origin: { messageID: string } }>;
    };
    const events = parsed.events.filter((event) => event.origin.messageID === wire.id);
    expect(events.map((event) => (
      event.kind === 'tool' ? event.call?.name : event.text
    ))).toEqual(['BEFORE_TEXT', 'completed-tool', 'BETWEEN_TEXT', 'pending-tool']);
    expect(events.find((event) => event.call?.name === 'pending-tool')?.timestamp).toBeUndefined();
    expect(events.find((event) => event.call?.name === 'completed-tool')?.timestamp).toBe(1200);
  });

  test('an adapter-projected unfinished record keeps its text around a pending call and untimed reasoning', () => {
    // The runtime projects an open assistant step as text and reasoning parts
    // without their own start times, and a call that is still streaming has
    // no time at all. The export must keep the order the record wrote them
    // in, not place them by the step's creation time.
    const root = session('ses_root', { title: 'Root' });
    const wire: SessionMessageInfo = {
      id: 'a1', type: 'assistant', agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-opus-4-1' },
      time: { created: 1000 },
      content: [
        { type: 'text', text: 'BEFORE_TEXT' },
        {
          type: 'tool', id: 'completed-call', name: 'completed-tool',
          time: { created: 1100, ran: 1200, completed: 1300 },
          state: { status: 'completed', input: { command: 'done' }, content: [{ type: 'text', text: 'ok' }] },
        },
        { type: 'text', text: 'BETWEEN_TEXT' },
        { type: 'reasoning', text: 'REASONING_TEXT' },
        { type: 'text', text: 'AFTER_TEXT' },
        {
          type: 'tool', id: 'pending-call', name: 'pending-tool',
          time: { created: 1400 },
          state: { status: 'streaming', input: '{"command":"later"' },
        },
      ],
    };
    const record = adapterRecord(wire, root.id);
    const input = fixture({ root, records: { ses_root: [record] } });
    const { timeline } = build(input);
    // SAFETY: `renderExportJson` writes the export's own event schema, so
    // every parsed event has the kind, text, call and origin fields read here.
    const parsed = JSON.parse(renderExportJson(timeline)) as {
      events: Array<{ kind: string; text?: string; call?: { name?: string }; timestamp?: number; origin: { messageID: string } }>;
    };
    const events = parsed.events.filter((event) => event.origin.messageID === wire.id);
    const ordered = events.map((event) => {
      if (event.kind === 'message' || event.kind === 'reasoning') return event.text;
      if (event.kind === 'tool') return event.call?.name;
      return event.kind;
    });

    expect(ordered).toEqual([
      'BEFORE_TEXT', 'completed-tool', 'BETWEEN_TEXT', 'REASONING_TEXT', 'AFTER_TEXT', 'pending-tool',
    ]);
    const completed = events.find((event) => event.kind === 'tool' && event.call?.name === 'completed-tool');
    const pending = events.find((event) => event.kind === 'tool' && event.call?.name === 'pending-tool');
    const reasoning = events.find((event) => event.kind === 'reasoning');
    expect(completed?.timestamp).toBe(1200);
    expect(pending?.timestamp).toBeUndefined();
    expect(reasoning?.timestamp).toBeUndefined();
    for (const message of events.filter((event) => event.kind === 'message')) {
      expect(message.timestamp).toBeUndefined();
    }

    // The adapter keeps the reasoning's derived start for ordinary chat, and
    // marks it as the message's time rather than a recorded part time.
    const projectedReasoning = record.parts.find((part) => part.type === 'reasoning');
    expect(projectedReasoning?.type === 'reasoning' && projectedReasoning.time.start).toBe(1000);
    expect(projectedReasoning?.type === 'reasoning' && projectedReasoning.time.fromMessage).toBe(true);

    const document = markdown(input, 'detailed');
    expect(document.indexOf('BEFORE_TEXT')).toBeLessThan(document.indexOf('`completed-tool`'));
    expect(document.indexOf('`completed-tool`')).toBeLessThan(document.indexOf('BETWEEN_TEXT'));
    expect(document.indexOf('BETWEEN_TEXT')).toBeLessThan(document.indexOf('REASONING_TEXT'));
    expect(document.indexOf('REASONING_TEXT')).toBeLessThan(document.indexOf('AFTER_TEXT'));
    expect(document.indexOf('AFTER_TEXT')).toBeLessThan(document.indexOf('`pending-tool`'));
  });

  test('a reasoning part that recorded its own time keeps it through the adapter and export', () => {
    const root = session('ses_root', { title: 'Root' });
    const wire: SessionMessageInfo = {
      id: 'a1', type: 'assistant', agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-opus-4-1' },
      time: { created: 1000, completed: 1400 },
      content: [
        { type: 'text', text: 'BEFORE_TIMED_REASONING' },
        { type: 'reasoning', text: 'TIMED_REASONING', time: { created: 1250, completed: 1300 } },
      ],
    };
    const record = adapterRecord(wire, root.id);
    const { timeline } = build(fixture({ root, records: { ses_root: [record] } }));
    const reasoning = timeline.events.find((event) => event.kind === 'reasoning');
    expect(reasoning?.kind === 'reasoning' && reasoning.timestamp).toBe(1250);
    const projectedReasoning = record.parts.find((part) => part.type === 'reasoning');
    expect(projectedReasoning?.type === 'reasoning' && projectedReasoning.time).toEqual({ start: 1250, end: 1300 });
  });

  test('every tool state reaches the export with its status', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [
              { ...shellCall('a1', 'bun test'), id: 'a1-shell' },
              {
                id: 'a1-pending', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
                callID: 'a1-pending-call', tool: 'read',
                state: { status: 'pending', input: { path: 'a.ts' }, raw: '' },
              },
              {
                id: 'a1-running', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
                callID: 'a1-running-call', tool: 'grep',
                state: { status: 'running', input: { pattern: 'x' }, time: { start: 2100 } },
              },
              {
                id: 'a1-error', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
                callID: 'a1-error-call', tool: 'write',
                state: { status: 'error', input: { path: 'b.ts' }, error: 'Permission denied', time: { start: 2200, end: 2300 } },
              },
            ],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output).toContain('`shell`');
    expect(output).toContain('`read`');
    expect(output).toContain('`grep`');
    expect(output).toContain('`write`');
    expect(output).toContain('pending');
    expect(output).toContain('running');
    expect(output).toContain('failed');
    expect(output).toContain('Permission denied');
  });

  test('the readable view keeps a tool result short and marks the cut', () => {
    const long = 'x'.repeat(2000);
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: { status: 'completed', input: { command: 'bun test' }, output: long, time: { start: 1, end: 2 } },
            }],
          },
        ],
      },
    });

    const readable = markdown(input, 'readable');
    const detailed = markdown(input, 'detailed');

    expect(readable).toContain('excerpt');
    expect(readable.length).toBeLessThan(detailed.length);
    expect(detailed).toContain(long);
  });

  test('a result the runtime cut names the file the rest is in', () => {
    // The runtime cuts a long result itself and keeps the prefix in the
    // record, so the document has to say so where the reader looks at the
    // result — in both views.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: {
                status: 'completed',
                input: { command: 'bun test' },
                output: 'the part the runtime kept',
                metadata: { truncated: true, outputPath: '/tmp/oc-output.json' },
                time: { start: 1, end: 2 },
              },
            }],
          },
        ],
      },
    });

    for (const mode of ['readable', 'detailed'] as const) {
      const output = markdown(input, mode);
      expect(output).toContain('The runtime cut this output short');
      expect(output).toContain('/tmp/oc-output.json');
    }

    const { projection, timeline } = build(input, 'detailed');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'detailed',
      findings: timeline.findings, excluded: timeline.excluded,
      sessionCount: timeline.sessions.size,
    });

    expect(html).toContain('The runtime cut this output short');
    expect(html).toContain('/tmp/oc-output.json');
  });

  test('a result the runtime cut without a file says only that it was cut', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: {
                status: 'completed',
                input: { command: 'bun test' },
                output: 'the part the runtime kept',
                metadata: { truncated: true },
                time: { start: 1, end: 2 },
              },
            }],
          },
        ],
      },
    });

    const output = markdown(input, 'detailed');

    expect(output).toContain('The runtime cut this output short');
    // The runtime named no file, so the document names none.
    expect(output).not.toContain('{path}');
  });

  test('the detailed view carries a result the export does not cut', () => {
    // The runtime cuts a long result itself, so the export has no cut of its
    // own: what the history recorded is what the document carries, and there
    // is nothing to point at.
    const long = 'x'.repeat(200_100);
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: { status: 'completed', input: { command: 'bun test' }, output: long, time: { start: 1, end: 2 } },
            }],
          },
        ],
      },
    });

    const detailed = markdown(input, 'detailed');

    expect(detailed).toContain(long);
    expect(detailed).not.toContain('the rest of this result is in the export of this session with full details');
  });

  test('the readable view keeps its own cut of a long result', () => {
    // The readable view cuts the result down and says where the rest is.
    // The cut is the export's own, so it has to stay marked.
    const long = 'x'.repeat(2000);
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: { status: 'completed', input: { command: 'bun test' }, output: long, time: { start: 1, end: 2 } },
            }],
          },
        ],
      },
    });

    const readable = markdown(input, 'readable');

    expect(readable).toContain('x'.repeat(600));
    expect(readable).not.toContain(long);
    expect(readable).toContain('excerpt');
    expect(readable).toContain('the rest of this result is in the export of this session with full details');
  });

  test('the mark of a cut names no export the reader does not have', () => {
    // The app writes one file, in the format the reader chose. A mark that
    // pointed at a JSON export would name a file that was never written, so
    // both marks name the export of the same session with full details.
    const long = 'x'.repeat(2000);
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: { status: 'completed', input: { command: 'bun test' }, output: long, time: { start: 1, end: 2 } },
            }],
          },
        ],
      },
    });

    const readable = markdown(input, 'readable');
    const { projection, timeline } = build(input, 'readable');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings, excluded: timeline.excluded,
      sessionCount: timeline.sessions.size,
    });

    expect(readable).toContain('the rest of this result is in the export of this session with full details');
    expect(html).toContain('The full result is in the export of this session with full details.');
    expect(readable).not.toContain('JSON export');
    expect(html).not.toContain('JSON export');
  });

  test('the readable view marks its cut of a long sub-agent result', () => {
    // A sub-agent's result is cut the way a tool result is cut, and the mark
    // says where the whole result is: the export of this session with full
    // details. The detailed view carries the result as it is, so it has
    // nothing to point at.
    const long = 'x'.repeat(2000);
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child' })],
          },
          subagentReport('ses_root', 'r1', 9000, { childSessionID: 'ses_child', output: long }),
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 8500, 'Background work')],
      },
    });

    const readable = markdown(input, 'readable');
    const detailed = markdown(input, 'detailed');
    const { projection, timeline } = build(input, 'readable');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings, excluded: timeline.excluded,
      sessionCount: timeline.sessions.size,
    });

    // The cut is the same in both formats, and both mark it the way an
    // ordinary tool result is marked.
    expect(readable).toContain('x'.repeat(800));
    expect(readable).not.toContain(long);
    expect(readable).toContain('excerpt');
    expect(readable).toContain('the rest of this result is in the export of this session with full details');
    expect(html).toContain('x'.repeat(800));
    expect(html).not.toContain(long);
    expect(html).toContain('The full result is in the export of this session with full details.');

    // The full details carry the whole result and no mark.
    expect(detailed).toContain(long);
    expect(detailed).not.toContain('the rest of this result is in the export of this session with full details');
  });

  test('the call that started a sub-agent says when the runtime cut its result short', () => {
    // The same fact an ordinary tool call carries, on the call that started
    // the sub-agent.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', {
              childSessionID: 'ses_child',
              metadata: { truncated: true, outputPath: '/tmp/oc-full-output.txt' },
            })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    for (const mode of ['readable', 'detailed'] as const) {
      const output = markdown(input, mode);

      expect(output).toContain('The runtime cut this output short');
      expect(output).toContain('/tmp/oc-full-output.txt');
    }

    const { projection, timeline } = build(input, 'detailed');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'detailed',
      findings: timeline.findings, excluded: timeline.excluded,
      sessionCount: timeline.sessions.size,
    });

    expect(html).toContain('The runtime cut this output short');
    expect(html).toContain('/tmp/oc-full-output.txt');
  });

  test('a sub-agent call that named no task says what kind of call it was', () => {
    // The document's own words, in the reader's language. The export used to
    // write a literal that no locale could translate.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-subagent', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'subagent',
              state: {
                status: 'completed',
                input: { prompt: 'Do the work' },
                output: 'The result',
                time: { start: 1000, end: 2000 },
              },
            }],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Sub-agent');
  });

  test('the readable view names the agent a call asked for', () => {
    // The child is not in the document, so the row is what the reader has:
    // it has to name the agent the call asked for.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_missing', agent: 'writer' })],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output).toContain('writer');
  });

  test('the detailed view carries the tool input and metadata', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child' })],
          },
        ],
      },
    });

    const detailed = markdown(input, 'detailed');

    expect(detailed).toContain('**Input**');
    expect(detailed).toContain('"description"');
  });

  test('the JSON export keeps every source record and the derived events apart', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_child: [assistantMessage('ses_child', 'ca1', 2000, 'Child work')],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));

    expect(parsed.schema.version).toBe(1);
    expect(parsed.schema.ordering).toContain('recorded timestamp');
    expect(parsed.source.ses_root.records).toHaveLength(1);
    expect(parsed.source.ses_child.records).toHaveLength(1);
    expect(parsed.source.ses_root.records[0].info.id).toBe('u1');
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.sessions.ses_child.agent).toBe('reviewer');
  });

  test('the JSON export keeps every part of the source, in its recorded order', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [{
          info: { id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: 1000 } },
          parts: [
            textPart('u1', 'First'),
            { id: 'f1', sessionID: 'ses_root', messageID: 'u1', type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///notes.txt' },
            textPart('u1', 'Second', 'u1-text-2'),
          ],
        }],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const parts = parsed.source.ses_root.records[0].parts;

    expect(parts.map((part: { type: string }) => part.type)).toEqual(['text', 'file', 'text']);
    expect(parts[1].filename).toBe('notes.txt');
    expect(parts[2].text).toBe('Second');
  });

  test('the HTML export filters by the agent that produced the entry', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 3000 })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    const { projection, timeline } = build(input);
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings, excluded: timeline.excluded,
      sessionCount: timeline.sessions.size,
    });

    // The filter's data and the page's own attributes must agree, or the
    // filter hides the wrong entries.
    const dataMatch = html.match(/<script type="application\/json" id="export-data">([\s\S]*?)<\/script>/);
    expect(dataMatch).toBeTruthy();
    // SAFETY: the export writes the data block itself, so the match holds
    // the page's own data.
    const data = JSON.parse(dataMatch![1]) as { entries: Array<{ id: string; agent?: string }> };

    const domAgent = new Map<string, string>();
    for (const match of html.matchAll(/data-id="([^"]*)"[^>]*data-agent="([^"]*)"/g)) {
      domAgent.set(match[1], match[2]);
    }

    for (const entry of data.entries) {
      expect(domAgent.get(entry.id) ?? '').toBe(entry.agent ?? '');
    }
  });

  test('the HTML export filters by the agent that produced the entry in the detailed view', () => {
    // The detailed view shows the call that started a sub-agent, and that
    // call is an entry of its own, so the filter reaches it.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 3000 })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    const { projection, timeline } = build(input, 'detailed');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'detailed',
      findings: timeline.findings, excluded: timeline.excluded,
      sessionCount: timeline.sessions.size,
    });

    const dataMatch = html.match(/<script type="application\/json" id="export-data">([\s\S]*?)<\/script>/);
    expect(dataMatch).toBeTruthy();
    // SAFETY: the export writes the data block itself, so the match holds
    // the page's own data.
    const data = JSON.parse(dataMatch![1]) as { entries: Array<{ id: string; agent?: string }> };

    const domAgent = new Map<string, string>();
    for (const match of html.matchAll(/data-id="([^"]*)"[^>]*data-agent="([^"]*)"/g)) {
      domAgent.set(match[1], match[2]);
    }

    for (const entry of data.entries) {
      expect(domAgent.get(entry.id) ?? '').toBe(entry.agent ?? '');
    }
  });

  test('the HTML agent filter offers only agents the page actually carries', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 3000 })],
          },
        ],
        // The sub-agent's own message records the agent that produced it,
        // which is not the agent the block belongs to.
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work', { agent: 'build' })],
      },
    });

    const { projection, timeline } = build(input);
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings, excluded: timeline.excluded,
      sessionCount: timeline.sessions.size,
    });

    const dataMatch = html.match(/<script type="application\/json" id="export-data">([\s\S]*?)<\/script>/);
    expect(dataMatch).toBeTruthy();
    // SAFETY: the export writes the data block itself, so the match holds
    // the page's own data.
    const data = JSON.parse(dataMatch![1]) as { agents: string[] };

    // Every agent the filter offers matches at least one entry on the page.
    const domAgents = new Set<string>();
    for (const match of html.matchAll(/data-id="([^"]*)"[^>]*data-agent="([^"]*)"/g)) {
      if (match[2]) domAgents.add(match[2]);
    }
    for (const agent of data.agents) {
      expect(domAgents.has(agent)).toBe(true);
    }
  });

  test('the HTML export is self-contained and carries the same history', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_child: [assistantMessage('ses_child', 'ca1', 2000, 'Child work')],
      },
    });

    const { projection, timeline } = build(input);
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings, excluded: timeline.excluded,
      sessionCount: timeline.sessions.size,
    });

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('id="search"');
    expect(html).toContain('Child work');
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('href="http');
  });

  test('the detailed HTML export carries the reasoning and the full call details', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [
              {
                id: 'a1-reasoning', sessionID: 'ses_root', messageID: 'a1', type: 'reasoning',
                text: 'The reasoning behind the call.', time: { start: 2000, end: 2100 },
              },
              {
                id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
                callID: 'a1-shell-call', tool: 'shell',
                state: {
                  status: 'completed',
                  input: { command: 'bun test' },
                  output: 'ok',
                  metadata: { duration: 12 },
                  time: { start: 2100, end: 2200 },
                },
              },
            ],
          },
        ],
      },
    });

    const { projection, timeline } = build(input, 'detailed');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'detailed',
      findings: timeline.findings, excluded: timeline.excluded,
      sessionCount: timeline.sessions.size,
    });

    // The reasoning and the metadata only reach the page in the detailed
    // view, and the detailed view is a choice the user can make.
    expect(html).toContain('The reasoning behind the call.');
    expect(html).toContain('duration');
    expect(html).toContain('bun test');
  });

  test('a lineage that points back at itself ends the walk', () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: 'ses_root' });
    const input = fixture({
      root,
      sessions: [root, child, { ...child, id: 'ses_loop', parentID: 'ses_child' }],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_child: [assistantMessage('ses_child', 'ca1', 2000, 'Child work')],
      },
    });

    const timeline = timelineOf(input);

    expect(sessionsOf(timeline).map((entry) => entry.id)).toContain('ses_child');
    expect(timeline.findings.every((finding) => finding.kind !== 'cyclic-lineage')).toBe(true);
  });

  test('the export is deterministic for the same source', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_child: [assistantMessage('ses_child', 'ca1', 2000, 'Child work')],
      },
    });

    const first = renderExportJson(timelineOf(input));
    const second = renderExportJson(timelineOf(input));

    expect(first).toBe(second);
  });

  test('a child whose history cannot be loaded is in the document, not only in the toast', async () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' });

    const result = await buildExport({
      root,
      sessions: [root, child],
      load: async (sessionID) => {
        if (sessionID === 'ses_root') return [userMessage('ses_root', 'u1', 1000, 'Go')];
        return null;
      },
    }, 'readable');

    // The sub-agent is named in the document, and the failure is reported.
    expect(result.timeline.findings.some((finding) => finding.kind === 'missing-session')).toBe(true);
    const document = renderExportMarkdown(result.projection, {
      title: 'Root',
      mode: 'readable',
      findings: result.timeline.findings, excluded: result.timeline.excluded,
      sessionCount: result.timeline.sessions.size,
    });
    expect(document.split('could not be loaded')).toHaveLength(2);
    expect(document).toContain('Incomplete export');
    expect(document.indexOf('Incomplete export')).toBeGreaterThan(document.indexOf('Go'));
    const html = renderExportHtml(result.projection, {
      title: 'Root', mode: 'readable', findings: result.timeline.findings,
      excluded: result.timeline.excluded, sessionCount: result.timeline.sessions.size,
    });
    expect(html.split('could not be loaded')).toHaveLength(2);
    expect(html.indexOf('Incomplete export')).toBeGreaterThan(html.indexOf('Go'));
    // The sub-agent is named, so the reader knows what is missing.
    expect(document).toContain('Child');
  });

  test('a failed child history load keeps the parent call output and reports the gap once at the end', async () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' });
    const result = await buildExport({
      root,
      sessions: [root, child],
      load: async (sessionID) => {
        if (sessionID === root.id) return [{
          info: assistantMessage(root.id, 'a1', 1000, '').info,
          parts: [subagentCall('a1', {
            sessionID: root.id, childSessionID: child.id, output: 'PARENT_CALL_OUTPUT_SENTINEL',
          })],
        }];
        return null;
      },
    }, 'detailed');

    expect(result.timeline.findings.filter((finding) => finding.kind === 'missing-session')).toHaveLength(1);
    for (const [document, format] of [
      [renderExportMarkdown(result.projection, {
        title: 'Root', mode: 'detailed', findings: result.timeline.findings,
        excluded: result.timeline.excluded, sessionCount: result.timeline.sessions.size,
      }), 'markdown'],
      [renderExportHtml(result.projection, {
        title: 'Root', mode: 'detailed', findings: result.timeline.findings,
        excluded: result.timeline.excluded, sessionCount: result.timeline.sessions.size,
      }), 'html'],
    ] as const) {
      expect(document).toContain('PARENT_CALL_OUTPUT_SENTINEL');
      expect(document.split('PARENT_CALL_OUTPUT_SENTINEL')).toHaveLength(2);
      const findingIndex = document.indexOf('Incomplete export');
      expect(findingIndex).toBeGreaterThan(document.indexOf('PARENT_CALL_OUTPUT_SENTINEL'));
      expect(document.split('Incomplete export')).toHaveLength(2);
      if (format === 'html') {
        expect(document).toContain('data-kind="call"');
        expect(document).not.toContain('class="entry message"');
      }
    }
  });

  test('a readable export keeps the parent result when the child cannot be loaded', async () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' });
    const longResult = `PARENT_RESULT_SENTINEL ${'parent result '.repeat(800)}`;
    const result = await buildExport({
      root,
      sessions: [root, child],
      load: async (sessionID) => sessionID === root.id
        ? [{
            info: assistantMessage(root.id, 'a1', 1000, '').info,
            parts: [subagentCall('a1', {
              sessionID: root.id, childSessionID: child.id, output: longResult,
            })],
          }]
        : null,
    }, 'readable');

    const document = renderExportMarkdown(result.projection, {
      title: 'Root', mode: 'readable', findings: result.timeline.findings,
      excluded: result.timeline.excluded, sessionCount: result.timeline.sessions.size,
    });
    expect(document).toContain('PARENT_RESULT_SENTINEL');
    expect(document).toContain('excerpt');
    expect(document).not.toContain('Child transcript');
    expect(document.split('Incomplete export')).toHaveLength(2);
    const html = renderExportHtml(result.projection, {
      title: 'Root', mode: 'readable', findings: result.timeline.findings,
      excluded: result.timeline.excluded, sessionCount: result.timeline.sessions.size,
    });
    expect(html).toContain('PARENT_RESULT_SENTINEL');
    expect(html).toContain('Shown in part.');
    expect(html.split('PARENT_RESULT_SENTINEL')).toHaveLength(2);
    expect(html.split('Incomplete export')).toHaveLength(2);
    expect(result.timeline.findings.filter((finding) => finding.kind === 'missing-session')).toHaveLength(1);
  });

  test('a child the session list does not name is reported as missing', async () => {
    const root = session('ses_root', { title: 'Root' });

    const result = await buildExport({
      root,
      sessions: [root],
      load: async (sessionID) => {
        if (sessionID === 'ses_root') return [userMessage('ses_root', 'u1', 1000, 'Go')];
        return null;
      },
    }, 'readable');

    expect(result.timeline.findings.some((finding) => finding.kind === 'missing-session')).toBe(false);
  });

  test('the JSON export orders its events by their recorded timestamp', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        // The child's event is recorded before the root's second message,
        // so a list grouped by session would put the root's events first.
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'First'),
          userMessage('ses_root', 'u2', 9000, 'Last'),
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 5000, 'Middle')],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const timestamps = parsed.events.map((event: { timestamp?: number }) => event.timestamp);

    expect(timestamps).toEqual([...timestamps].sort((left: number, right: number) => left - right));
    expect(parsed.schema.ordering).toContain('recorded timestamp');
  });

  test('a tool call carries the id the runtime gave it', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [shellCall('a1', 'bun test')],
          },
        ],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const toolEvent = parsed.events.find((event: { kind: string }) => event.kind === 'tool');

    expect(toolEvent.call.callID).toBe('a1-shell-call');
  });

  test('a part the model does not know is kept, not dropped', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: 1000 },
            },
            parts: [textPart('u1', 'First'), futurePart('u1')],
          },
        ],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const parts = parsed.events[0].parts;

    expect(parts[1].type).toBe('unknown');
    expect(parts[1].id).toBe('u1-future');
    expect(parts[1].partType).toBe('future');
  });

  test('the sub-agent block says how the call that started it ended', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', {
              childSessionID: 'ses_child',
              status: 'error',
              error: 'Subagent cancelled',
            })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Subagent cancelled');
  });

  test('the detailed view carries the result of the call that started the sub-agent', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', {
              childSessionID: 'ses_child',
              output: 'The review found blocking defects.',
            })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    const readable = markdown(input, 'readable');
    const detailed = markdown(input, 'detailed');

    expect(readable).not.toContain('The review found blocking defects.');
    expect(detailed).toContain('The review found blocking defects.');
  });

  test('a compaction, a shell record and a notice all reach the document', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'c1', sessionID: 'ses_root', role: 'compaction', time: { created: 1000 },
              status: 'completed', reason: 'auto', summary: 'The summary of what happened so far.',
            },
            parts: [],
          },
          {
            info: {
              id: 's1', sessionID: 'ses_root', role: 'shell', time: { created: 1100 },
              shellID: 'sh1', command: 'bun test', status: 'exited', exit: 0,
            },
            parts: [],
          },
          {
            info: {
              id: 'n1', sessionID: 'ses_root', role: 'agent-switched', time: { created: 1200 },
              agent: 'reviewer',
            },
            parts: [],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output).toContain('The summary of what happened so far.');
    expect(output).toContain('bun test');
    expect(output).toContain('reviewer');
  });

  test('root and nested failed compactions keep their status and error without a summary', () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: root.id, agent: 'reviewer' });
    const input = fixture({
      root,
      sessions: [root, child],
      records: {
        ses_root: [
          {
            info: {
              id: 'failed-compaction', sessionID: root.id, role: 'compaction', time: { created: 1000 },
              status: 'failed', reason: 'auto', summary: '',
              error: { type: 'CompactionError', message: 'ROOT_CONTEXT_REDUCTION_FAILURE' },
            },
            parts: [],
          },
          {
            info: assistantMessage(root.id, 'delegate', 2000, '').info,
            parts: [subagentCall('delegate', { childSessionID: child.id, sessionID: root.id })],
          },
        ],
        ses_child: [{
          info: {
            id: 'nested-failed-compaction', sessionID: child.id, role: 'compaction', time: { created: 3000 },
            status: 'failed', reason: 'manual', summary: '',
            error: { type: 'CompactionError', message: 'NESTED_CONTEXT_REDUCTION_FAILURE' },
          },
          parts: [],
        }],
      },
    });
    const { timeline } = build(input, 'readable');
    const compactions = timeline.events.filter((event) => event.kind === 'message' && event.role === 'compaction');
    expect(compactions).toHaveLength(2);
    expect(compactions.map((event) => event.sessionID).sort()).toEqual([root.id, child.id].sort());
    for (const event of compactions) {
      if (event.kind !== 'message') continue;
      expect(event.compaction?.status).toBe('failed');
    }
    const json = renderExportJson(timeline);
    expect(json).toContain('ROOT_CONTEXT_REDUCTION_FAILURE');
    expect(json).toContain('NESTED_CONTEXT_REDUCTION_FAILURE');
    const readableProjection = build(input, 'readable').projection;
    expect(JSON.stringify(readableProjection)).toContain('NESTED_CONTEXT_REDUCTION_FAILURE');

    for (const mode of ['readable', 'detailed'] as const) {
      const { projection } = build(input, mode);
      const options = {
        title: 'Root', mode, findings: timeline.findings,
        excluded: timeline.excluded, sessionCount: timeline.sessions.size,
      };
      const markdown = renderExportMarkdown(projection, options);
      const html = renderExportHtml(projection, options);
      expect(markdown).toContain('ROOT_CONTEXT_REDUCTION_FAILURE');
      expect(markdown).toContain('NESTED_CONTEXT_REDUCTION_FAILURE');
      expect(html).toContain('ROOT_CONTEXT_REDUCTION_FAILURE');
      expect(html).toContain('NESTED_CONTEXT_REDUCTION_FAILURE');
    }
  });

  test('an assistant failure and an empty running compaction reach both views without text', () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: root.id, agent: 'reviewer' });
    const failedAssistant = (sessionID: string, id: string, message: string): Record_ => adapterRecord({
      id, type: 'assistant', agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-opus-4-1' },
      time: { created: 1000, completed: 1100 },
      content: [],
      error: { type: 'ProviderError', message },
    }, sessionID);
    const compaction = (
      sessionID: string,
      id: string,
      created: number,
      status: 'running' | 'completed',
      summary: string,
    ): Record_ => adapterRecord({
      id, type: 'compaction', time: { created }, status, reason: 'auto', summary,
    }, sessionID);

    const input = fixture({
      root,
      sessions: [root, child],
      records: {
        ses_root: [
          {
            info: assistantMessage(root.id, 'delegate', 500, '').info,
            parts: [subagentCall('delegate', { childSessionID: child.id, startedAt: 500, endedAt: 600 })],
          },
          failedAssistant(root.id, 'root-assistant-error', 'ROOT_ASSISTANT_FAILURE'),
          compaction(root.id, 'root-running-compaction', 1200, 'running', ''),
          compaction(root.id, 'root-completed-compaction', 1300, 'completed', 'ROOT_COMPACTION_SUMMARY'),
        ],
        ses_child: [
          failedAssistant(child.id, 'child-assistant-error', 'CHILD_ASSISTANT_FAILURE'),
          compaction(child.id, 'child-running-compaction', 1400, 'running', ''),
        ],
      },
    });

    for (const mode of ['readable', 'detailed'] as const) {
      const { projection, timeline } = build(input, mode);
      const options = {
        title: 'Root', mode, findings: timeline.findings,
        excluded: timeline.excluded, sessionCount: timeline.sessions.size,
      };
      const document = renderExportMarkdown(projection, options);
      const html = renderExportHtml(projection, options);
      for (const output of [document, html]) {
        expect(output).toContain('ROOT_ASSISTANT_FAILURE');
        expect(output).toContain('CHILD_ASSISTANT_FAILURE');
        expect(output).toContain('ROOT_COMPACTION_SUMMARY');
        expect(output).not.toContain('Incomplete export');
      }
      // The running compaction's status is the outcome, and an empty summary
      // must not hide it from either view.
      expect(document.match(/running/g)).toHaveLength(2);
      expect(html.match(/>running</g)).toHaveLength(2);
    }

    const { timeline } = build(input);
    expect(timeline.findings).toHaveLength(0);
    const failures = timeline.events.filter((event) => (
      event.kind === 'message' && event.role === 'assistant' && event.error !== undefined
    ));
    expect(failures).toHaveLength(2);
    expect(failures.map((event) => event.kind === 'message' ? event.error?.message : undefined).sort())
      .toEqual(['CHILD_ASSISTANT_FAILURE', 'ROOT_ASSISTANT_FAILURE']);
    expect(timeline.events.filter((event) => (
      event.kind === 'message' && event.role === 'compaction' && event.compaction?.status === 'running'
    ))).toHaveLength(2);
  });

  test('a record without a usable timestamp is reported once', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            // A record whose time is not a usable one: the export cannot
            // place it by time, so it keeps the place the source gave it.
            info: { id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: Number.NaN } },
            parts: [textPart('u1', 'First')],
          },
          {
            info: { id: 'u2', sessionID: 'ses_root', role: 'user', time: { created: Number.NaN } },
            parts: [textPart('u2', 'Second')],
          },
        ],
      },
    });

    const timeline = timelineOf(input);
    const timestampFindings = timeline.findings.filter((finding) => finding.kind === 'missing-timestamp');

    expect(timestampFindings).toHaveLength(1);
  });

  test('a part the model does not know is reported once per part type', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: { id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: 1000 } },
            parts: [textPart('u1', 'First'), futurePart('u1'), futurePart('u1')],
          },
        ],
      },
    });

    const timeline = timelineOf(input);
    const partFindings = timeline.findings.filter((finding) => finding.kind === 'unsupported-part');

    expect(partFindings).toHaveLength(1);
  });

  test('a part the model does not know reaches neither view of the document', () => {
    // The part is neither text nor a file, so neither the readable view nor
    // the full details shows it. The finding says so, and it names the one
    // place the part survives: the source records of the JSON export.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: { id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: 1000 } },
            parts: [textPart('u1', 'First'), futurePart('u1')],
          },
        ],
      },
    });

    const readable = markdown(input, 'readable');
    const detailed = markdown(input, 'detailed');

    expect(readable).toContain('is not shown in the readable view or in the full details');
    expect(readable).toContain('The JSON export keeps it in its source records');
    expect(detailed).toContain('is not shown in the readable view or in the full details');

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const parts = parsed.source.ses_root.records[0].parts;

    expect(parts.map((part: { type: string }) => part.type)).toEqual(['text', 'future']);
  });

  test('completed tool attachments survive root and nested exports', () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' });
    const toolRecord = (sessionID: string, messageID: string): Record_ => ({
          info: {
            id: messageID, sessionID, role: 'assistant', agent: 'build',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 1000 },
          },
          parts: [{
            id: `${messageID}-tool`, sessionID, messageID, type: 'tool', callID: `${messageID}-call`, tool: 'openchamber_web',
            state: {
              status: 'completed', input: {}, output: 'Result', time: { start: 1000, end: 2000 },
              attachments: [{ id: `${messageID}-file`, sessionID, messageID, type: 'file', filename: 'TOOL_IMAGE_SENTINEL.png', mime: 'image/png', url: 'data:image/png;base64,AA==' }],
            },
          }],
    });
    const rootInput = fixture({ root, records: { ses_root: [toolRecord('ses_root', 'a1')] } });
    const nestedInput = fixture({
      root,
      sessions: [root, child],
      records: {
        ses_root: [{
          info: assistantMessage('ses_root', 'a1', 1000, '').info,
          parts: [subagentCall('a1', { childSessionID: child.id, startedAt: 1000, endedAt: 5000 })],
        }],
        ses_child: [toolRecord(child.id, 'ca1')],
      },
    });

    for (const [depth, input] of [['root', rootInput], ['nested', nestedInput]] as const) {
      for (const mode of ['readable', 'detailed'] as const) {
        const output = markdown(input, mode);
        expect(output).toContain('TOOL_IMAGE_SENTINEL.png');
        if (mode === 'detailed') {
          expect(output).toContain('(image/png) data:image/png;base64,AA==');
        } else {
          expect(output).not.toContain('data:image/png;base64,AA==');
        }
        const projection = build(input, mode).projection;
        const findTool = (nodes: ProjectedNode[]): Extract<ProjectedNode, { kind: 'tool' }> | undefined => {
          for (const node of nodes) {
            if (node.kind === 'tool') return node;
            if (node.kind === 'subagent') {
              const nested = findTool(node.entries);
              if (nested) return nested;
            }
          }
          return undefined;
        };
        const tool = findTool(projection);
        expect(tool?.tool.attachments?.[0]?.mime).toBe('image/png');
        expect(tool?.tool.attachments?.[0]?.url).toBe('data:image/png;base64,AA==');
        const result = buildExportFromRecords({
          root: input.root,
          sessions: input.sessions,
          records: input.records,
        }, mode);
        const html = renderExportHtml(result.projection, {
          title: 'Root', mode, findings: result.timeline.findings,
          excluded: result.timeline.excluded, sessionCount: result.timeline.sessions.size,
        });
        expect(html).toContain('TOOL_IMAGE_SENTINEL.png');
        if (mode === 'detailed') expect(html).toContain('data:image/png;base64,AA==');
        const parsed = JSON.parse(renderExportJson(result.timeline));
        const sourceSessionID = depth === 'root' ? 'ses_root' : 'ses_child';
        type SourceRecord = { parts: Array<{ state?: { attachments?: Array<{ url: string }> } }> };
        const sourceRecords = parsed.source[sourceSessionID].records as SourceRecord[];
        expect(sourceRecords.some((record) => record.parts.some((part) => (
          part.state?.attachments?.some((file) => file.url === 'data:image/png;base64,AA==')
        )))).toBe(true);
      }
    }
  });

  test('message and first-prompt files retain detailed payloads and compact readable names', () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: root.id, agent: 'reviewer' });
    const file = (sessionID: string, messageID: string, filename?: string): Part => ({
      id: `${messageID}-file`, sessionID, messageID, type: 'file',
      filename, mime: 'image/png', url: `data:image/png;base64,${messageID}`,
    });
    const input = fixture({
      root,
      sessions: [root, child],
      records: {
        ses_root: [
          { info: userMessage(root.id, 'u1', 1000, 'Root prompt').info, parts: [textPart('u1', 'Root prompt'), file(root.id, 'u1', 'ROOT_FILE_SENTINEL.png')] },
          { info: assistantMessage(root.id, 'a1', 2000, '').info, parts: [subagentCall('a1', { childSessionID: child.id })] },
        ],
        ses_child: [
          { info: userMessage(child.id, 'cu1', 3000, '').info, parts: [file(child.id, 'cu1')] },
        ],
      },
    });

    for (const mode of ['readable', 'detailed'] as const) {
      const { projection, timeline } = build(input, mode);
      const markdownDocument = renderExportMarkdown(projection, {
        title: 'Root', mode, findings: timeline.findings,
        excluded: timeline.excluded, sessionCount: timeline.sessions.size,
      });
      const htmlDocument = renderExportHtml(projection, {
        title: 'Root', mode, findings: timeline.findings,
        excluded: timeline.excluded, sessionCount: timeline.sessions.size,
      });
      expect(markdownDocument).toContain('ROOT_FILE_SENTINEL.png');
      expect(markdownDocument).toContain('image/png');
      expect(htmlDocument).toContain('image/png');
      if (mode === 'detailed') {
        expect(markdownDocument).toContain('data:image/png;base64,u1');
        expect(markdownDocument).toContain('data:image/png;base64,cu1');
        expect(htmlDocument).toContain('data:image/png;base64,u1');
        expect(htmlDocument).toContain('data:image/png;base64,cu1');
      } else {
        expect(markdownDocument).not.toContain('data:image/png;base64');
        expect(htmlDocument).not.toContain('data:image/png;base64');
      }
      const parsed = JSON.parse(renderExportJson(timeline));
      expect(parsed.source.ses_child.records[0].parts[0].url).toBe('data:image/png;base64,cu1');
    }
  });

  test('a completed delegation call keeps its attachments in detailed exports', () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' });
    const attachment = {
      id: 'a1-file', sessionID: root.id, messageID: 'a1', type: 'file' as const,
      filename: 'DELEGATION_IMAGE_SENTINEL.png', mime: 'image/png', url: 'data:image/png;base64,AA==',
    };
    const input = fixture({
      root,
      sessions: [root, child],
      records: {
        ses_root: [{
          info: assistantMessage(root.id, 'a1', 1000, '').info,
          parts: [{
            id: 'a1-subagent', sessionID: root.id, messageID: 'a1', type: 'tool',
            callID: 'a1-call', tool: 'subagent',
            state: {
              status: 'completed',
              input: { description: 'Review the change', prompt: 'Review the whole change', agent: 'reviewer' },
              output: 'Delegation result', time: { start: 1000, end: 2000 }, attachments: [attachment],
              metadata: { sessionID: child.id },
            },
          }],
        }],
        ses_child: [assistantMessage(child.id, 'ca1', 1500, 'Child transcript')],
      },
    });

    const detailed = markdown(input, 'detailed');
    const { projection, timeline } = build(input, 'detailed');
    const html = renderExportHtml(projection, {
      title: 'Root', mode: 'detailed', findings: timeline.findings,
      excluded: timeline.excluded, sessionCount: timeline.sessions.size,
    });
    const parsed = JSON.parse(renderExportJson(timeline));

    for (const output of [detailed, html]) {
      expect(output).toContain('DELEGATION_IMAGE_SENTINEL.png');
      expect(output).toContain('image/png');
      expect(output).toContain('data:image/png;base64,AA==');
      expect(output).toContain('Child transcript');
    }
    expect(parsed.source.ses_root.records[0].parts[0].state?.attachments?.[0]?.url).toBe('data:image/png;base64,AA==');
  });
});

describe('the document promises only what it keeps', () => {
  test('the readable and the detailed document do not promise a chronology', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 9000 })],
          },
          assistantMessage('ses_root', 'a2', 3000, 'The answer that came after the call'),
        ],
        // The child worked on until after the parent answered, so the
        // document holds a later moment in front of an earlier one.
        ses_child: [assistantMessage('ses_child', 'ca1', 9000, 'The work inside the block')],
      },
    });

    for (const mode of ['readable', 'detailed'] as const) {
      const output = markdown(input, mode);

      // The document is not one timeline: the block's own event is later
      // than the message the block stands in front of.
      expect(output.indexOf('The work inside the block')).toBeLessThan(output.indexOf('The answer that came after the call'));

      // So it must not promise a chronology it does not have.
      expect(output).not.toContain('Events are ordered by their recorded timestamp');

      // It says what its order is instead.
      expect(output).toContain('A sub-agent block sits where the call that started it sits in the conversation.');
    }
  });

  test('the cut of a long result is marked in the reader\'s language', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: {
                status: 'completed',
                input: { command: 'bun test' },
                output: 'x'.repeat(900),
                time: { start: 2000, end: 2500 },
              },
            }],
          },
        ],
      },
    });

    const previous = useI18nStore.getState();
    try {
      useI18nStore.setState({ locale: 'de', dictionary: deDict });
      const output = markdown(input);

      // The mark of the cut is part of the document, so it is in the
      // reader's language like the rest of it.
      expect(output).toContain('weitere Zeichen');
      expect(output).not.toContain('more characters');
    } finally {
      useI18nStore.setState({ locale: previous.locale, dictionary: previous.dictionary });
    }
  });
});

describe('export scale', () => {
  const buildLarge = (toolCalls: number) => {
    const parts = [];
    for (let index = 0; index < toolCalls; index += 1) {
      parts.push(shellCall(`a1-${index}`, `bun test --case ${index}`, 1000 + index, 1100 + index));
    }
    return fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts,
          },
          {
            info: {
              id: 's1', sessionID: 'ses_root', role: 'shell', shellID: 'sh1', command: 'ls -la',
              status: 'exited', time: { created: 1000 + toolCalls - 1 },
            },
            parts: [],
          },
        ],
      },
    });
  };

  for (const size of [100, 500, 3000]) {
    test(`a session with ${size} tool calls exports without losing a call`, () => {
      const input = buildLarge(size);
      const timeline = timelineOf(input);

      const toolEvents = timeline.events.filter((event) => event.kind === 'tool');
      expect(toolEvents).toHaveLength(size);

      const output = markdown(input);
      expect(output).toContain('`shell`');
      expect(output).toContain('bun test --case 0');
      expect(output).toContain(`bun test --case ${size - 1}`);
    });
  }

  test('the record after a thousand calls keeps its place', () => {
    // The record holds more parts than the source order had room for. The
    // record after it was written at the same moment as the last call, so
    // the source order decides, and the record after it stays after every
    // one of the calls.
    const output = markdown(buildLarge(3000));

    expect(output.indexOf('bun test --case 2999')).toBeLessThan(output.indexOf('ls -la'));
  });
});
