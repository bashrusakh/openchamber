import { describe, expect, test } from 'bun:test';
import type { Message, Part, Session } from '@/lib/opencode/model';
import { collectExportSessions } from '@/lib/export/collect';

import { buildSessionExportRecords, buildSessionMessageRecordsSnapshot } from './sync-context';
import { INITIAL_STATE, type State } from './types';

// v2 messages carry no `parentID`; the argument is kept only so the fixtures
// still read as "this reply belongs to that prompt".
const message = (id: string, role: 'user' | 'assistant', _parentID?: string, created = 1): Message =>
  role === 'user'
    ? { id, role, sessionID: 'ses_1', time: { created } }
    : { id, role, sessionID: 'ses_1', time: { created }, agent: 'build', providerID: 'provider', modelID: 'model' };

const textPart = (id: string, text: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'text',
  text,
});

/** A part that belongs to the record it is named after. */
const partOf = (messageID: string, text: string): Part => ({
  id: `${messageID}-text`,
  sessionID: 'ses_1',
  messageID,
  type: 'text',
  text,
});

const taskPart = (id: string, sessionId?: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'tool',
  callID: id,
  tool: 'task',
  state: {
    status: 'running',
    input: {},
    time: { start: 1 },
    metadata: sessionId ? { sessionId } : {},
  },
});

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  projectID: 'proj_1',
  directory: '/repo',
  title: 'Session',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...overrides,
});

const state = (partial: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...partial,
});

describe('buildSessionMessageRecordsSnapshot', () => {
  test('renders and reverts a rollover-spanning transcript by array chronology', () => {
    const before = message('msg_ffffffffffffBefore', 'user', undefined, 100);
    const marker = message('msg_000000000000Marker', 'user', undefined, 200);
    const after = message('msg_000000000001After', 'assistant', marker.id, 300);

    const snapshot = buildSessionMessageRecordsSnapshot(
      state({
        session: [session({ revert: { messageID: marker.id } })],
        message: { ses_1: [before, marker, after] },
      }),
      'ses_1',
    );

    expect(snapshot.list.map((record) => record.info.id)).toEqual([before.id]);
  });

  test('only suspends part updates for the active streaming message', () => {
    const user = message('user_1', 'user');
    const assistant1 = message('assistant_1', 'assistant', 'user_1');
    const assistant2 = message('assistant_2', 'assistant', 'user_1');
    const messages = [user, assistant1, assistant2];
    const assistant1InitialParts = [textPart('assistant_1_initial', 'initial')];
    const assistant2InitialParts = [textPart('assistant_2_initial', 'initial')];

    const previous = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1InitialParts,
          assistant_2: assistant2InitialParts,
        },
      }),
      'ses_1',
      undefined,
      true,
      'assistant_1',
    );

    const assistant1FinalParts = [textPart('assistant_1_final', 'final')];
    const assistant2LiveParts = [textPart('assistant_2_live', 'live')];
    const next = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1FinalParts,
          assistant_2: assistant2LiveParts,
        },
      }),
      'ses_1',
      previous,
      true,
      'assistant_2',
    );

    expect(next.byId.get('assistant_1')?.parts).toBe(assistant1FinalParts);
    expect(next.byId.get('assistant_2')?.parts).toBe(assistant2InitialParts);
  });

  test('publishes task session identity while other streaming part updates are suspended', () => {
    const assistant = message('assistant_1', 'assistant');
    const initialParts = [taskPart('task_1')];
    const previous = buildSessionMessageRecordsSnapshot(
      state({ message: { ses_1: [assistant] }, part: { assistant_1: initialParts } }),
      'ses_1',
      undefined,
      true,
      assistant.id,
    );
    const identifiedParts = [taskPart('task_1', 'child_1')];

    const next = buildSessionMessageRecordsSnapshot(
      state({ message: { ses_1: [assistant] }, part: { assistant_1: identifiedParts } }),
      'ses_1',
      previous,
      true,
      assistant.id,
    );

    expect(next.byId.get(assistant.id)?.parts).toBe(identifiedParts);
  });
});

describe('buildSessionExportRecords', () => {
  const before = message('msg_before', 'user', undefined, 100);
  const marker = message('msg_marker', 'user', undefined, 200);
  const after = message('msg_after', 'assistant', marker.id, 300);
  const part = {
    msg_before: [partOf('msg_before', 'before')],
    msg_marker: [partOf('msg_marker', 'marker')],
    msg_after: [partOf('msg_after', 'after')],
  };

  test('a staged revert carries the records the runtime wrote', () => {
    const snapshot = buildSessionMessageRecordsSnapshot(
      state({
        session: [session({ revert: { messageID: marker.id } })],
        message: { ses_1: [before, marker, after] },
        part,
      }),
      'ses_1',
    );

    const records = buildSessionExportRecords(snapshot, part);

    // The conversation is what the app shows: everything before the marker.
    expect(records.records.map((record) => record.info.id)).toEqual([before.id]);
    // The source records are what the runtime wrote, hidden messages included.
    expect(records.sourceRecords?.map((record) => record.info.id)).toEqual([before.id, marker.id, after.id]);
    expect(records.sourceRecords?.map((record) => record.parts[0]?.type)).toEqual(['text', 'text', 'text']);
    expect(records.revertMessageID).toBe(marker.id);
  });

  test('a marker the records do not hold cut nothing', () => {
    const snapshot = buildSessionMessageRecordsSnapshot(
      state({
        session: [session({ revert: { messageID: 'msg_not_here' } })],
        message: { ses_1: [before, marker, after] },
        part,
      }),
      'ses_1',
    );

    const records = buildSessionExportRecords(snapshot, part);

    expect(records.records.map((record) => record.info.id)).toEqual([before.id, marker.id, after.id]);
    expect(records.sourceRecords).toBeUndefined();
    expect(records.revertMessageID).toBeUndefined();
  });

  test('a session without a staged revert carries one set of records', () => {
    const snapshot = buildSessionMessageRecordsSnapshot(
      state({ message: { ses_1: [before, after] }, part }),
      'ses_1',
    );

    const records = buildSessionExportRecords(snapshot, part);

    expect(records.records.map((record) => record.info.id)).toEqual([before.id, after.id]);
    expect(records.sourceRecords).toBeUndefined();
    expect(records.revertMessageID).toBeUndefined();
  });
});

/**
 * The seam between the app's read and the export's collector.
 *
 * The two are separate implementations of one rule: the app's read carries
 * the records the runtime wrote only when a staged revert cut something, and
 * the collector raises a note only when the records it was given say so. The
 * test runs the real read into the real collector, so a change to either
 * half that breaks the other shows up here.
 *
 * It sits here, and not in the export's own tests, because the export is the
 * lower layer: the export never reads the app's state, so the test that
 * joins the two is the app's to write.
 */
describe('the export reads what the app read', () => {
  const before = message('msg_before', 'user', undefined, 100);
  const marker = message('msg_marker', 'user', undefined, 200);
  const after = message('msg_after', 'assistant', marker.id, 300);
  const part = {
    msg_before: [partOf('msg_before', 'before')],
    msg_marker: [partOf('msg_marker', 'marker')],
    msg_after: [partOf('msg_after', 'after')],
  };

  const collect = async (records: ReturnType<typeof buildSessionExportRecords>) => collectExportSessions({
    root: { id: 'ses_1', title: 'Session' },
    sessions: [{ id: 'ses_1', title: 'Session' }],
    load: async () => records,
  });

  test('a staged revert reaches the export as a note with the source records', async () => {
    const read = buildSessionExportRecords(buildSessionMessageRecordsSnapshot(
      state({
        session: [session({ revert: { messageID: marker.id } })],
        message: { ses_1: [before, marker, after] },
        part,
      }),
      'ses_1',
    ), part);

    const collection = await collect(read);

    // The export established everything, so the staged revert is a note and
    // not a finding: a complete export carries no integrity notice.
    expect(collection.notes.map((note) => note.kind)).toEqual(['staged-revert']);
    expect(collection.notes[0]?.sessionID).toBe('ses_1');
    expect(collection.notes[0]?.marker).toBe(marker.id);
    expect(collection.findings).toEqual([]);
    // The conversation is what the app shows, and the records the runtime
    // wrote travel with it.
    expect(collection.sessions[0]?.records.map((record) => record.info.id)).toEqual([before.id]);
    expect(collection.sessions[0]?.sourceRecords?.map((record) => record.info.id))
      .toEqual([before.id, marker.id, after.id]);
  });

  test('a session without a staged revert raises no note', async () => {
    const read = buildSessionExportRecords(buildSessionMessageRecordsSnapshot(
      state({ message: { ses_1: [before, after] }, part }),
      'ses_1',
    ), part);

    const collection = await collect(read);

    expect(read.sourceRecords).toBeUndefined();
    expect(collection.notes).toEqual([]);
    expect(collection.findings).toEqual([]);
    expect(collection.sessions[0]?.sourceRecords).toBeUndefined();
  });
});
