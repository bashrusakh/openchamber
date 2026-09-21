import { afterEach, describe, expect, it } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';

const SESSION_ID = 'ses_normal';
const ADVISOR_ID = 'ses_advisor';
const DIRECTORY = '/workspace';
// Mirrors PUSH_QUESTION_DEBOUNCE_MS / PUSH_PERMISSION_DEBOUNCE_MS in runtime.js.
const DEBOUNCE_WAIT_MS = 650;

const advisorMarker = {
  kind: 'consult-advisor',
  originalSessionID: 'ses_parent',
  consultRunID: 'run_1',
  advisorIndex: 0,
};

const normalSession = { id: SESSION_ID, title: 'Normal session', directory: DIRECTORY, metadata: {} };
const advisorSession = { id: ADVISOR_ID, title: 'Advisor fork', directory: DIRECTORY, metadata: { openchamber: advisorMarker } };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const createHarness = ({ normal = normalSession, advisor = advisorSession, settings = {} } = {}) => {
  const pushPayloads = [];
  const apnsPayloads = [];
  const uiNotifications = [];
  const fetchedPaths = [];

  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    fetchedPaths.push(path);
    if (path === `/session/${normal.id}`) {
      return jsonResponse(normal);
    }
    if (path === `/session/${advisor.id}`) {
      return jsonResponse(advisor);
    }
    throw new Error(`Unexpected fetch: ${path}`);
  };

  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({
      notifyOnSubtasks: true,
      notifyOnCompletion: true,
      notifyOnError: true,
      notifyOnQuestion: true,
      notificationMode: 'always',
      nativeNotificationsEnabled: false,
      notificationTemplates: {},
      ...settings,
    }),
    prepareNotificationLastMessage: async ({ message }) => message,
    buildTemplateVariables: async () => ({ session_name: 'Session name' }),
    extractLastMessageText: () => 'Finished.',
    fetchLastAssistantMessageText: async () => '',
    resolveNotificationTemplate: (template) => template,
    shouldApplyResolvedTemplateMessage: () => true,
    emitDesktopNotification: () => false,
    broadcastUiNotification: (payload) => { uiNotifications.push(payload); },
    sendPushToAllUiSessions: (payload) => { pushPayloads.push(payload); },
    sendApnsToAllUiSessions: (payload) => { apnsPayloads.push(payload); },
    isAnyInteractiveClientVisible: () => false,
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
  });

  return { runtime, pushPayloads, apnsPayloads, uiNotifications, fetchedPaths };
};

const completionPayload = (sessionId) => ({
  type: 'message.updated',
  properties: {
    directory: DIRECTORY,
    info: {
      id: 'msg_completion',
      sessionID: sessionId,
      role: 'assistant',
      finish: 'stop',
      mode: 'build',
      modelID: 'gpt-5.2',
    },
  },
});

const errorPayload = (sessionId) => ({
  type: 'message.updated',
  properties: {
    directory: DIRECTORY,
    info: {
      id: 'msg_error',
      sessionID: sessionId,
      role: 'assistant',
      finish: 'error',
      mode: 'build',
      modelID: 'gpt-5.2',
    },
  },
});

const questionPayload = (sessionId, directory = DIRECTORY) => ({
  type: 'question.asked',
  properties: {
    directory,
    sessionID: sessionId,
    questions: [{ header: 'Plan mode', question: 'Proceed with the plan?' }],
  },
});

const permissionPayload = (sessionId) => ({
  type: 'permission.asked',
  properties: {
    directory: DIRECTORY,
    sessionID: sessionId,
    id: 'perm_1',
    permission: 'bash',
    sessionTitle: 'Session name',
  },
});

const waitForDebounce = () => new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

describe('advisor fork push suppression', () => {
  it('suppresses completions for an advisor fork with no parentID, with subtask notifications on and off', async () => {
    for (const notifyOnSubtasks of [true, false]) {
      const harness = createHarness({ settings: { notifyOnSubtasks } });

      await harness.runtime.maybeSendPushForTrigger(completionPayload(ADVISOR_ID));

      expect(harness.pushPayloads).toHaveLength(0);
      expect(harness.apnsPayloads).toHaveLength(0);
      expect(harness.uiNotifications).toHaveLength(0);
    }
  });

  it('suppresses error notifications for an advisor fork', async () => {
    const harness = createHarness();

    await harness.runtime.maybeSendPushForTrigger(errorPayload(ADVISOR_ID));

    expect(harness.pushPayloads).toHaveLength(0);
    expect(harness.apnsPayloads).toHaveLength(0);
  });

  it('suppresses question notifications for an advisor fork after the debounce', async () => {
    const harness = createHarness();

    await harness.runtime.maybeSendPushForTrigger(questionPayload(ADVISOR_ID));
    await waitForDebounce();

    expect(harness.fetchedPaths).toContain(`/session/${ADVISOR_ID}`);
    expect(harness.pushPayloads).toHaveLength(0);
    expect(harness.apnsPayloads).toHaveLength(0);
  });

  it('suppresses permission notifications for an advisor fork after the debounce', async () => {
    const harness = createHarness();

    await harness.runtime.maybeSendPushForTrigger(permissionPayload(ADVISOR_ID));
    await waitForDebounce();

    expect(harness.fetchedPaths).toContain(`/session/${ADVISOR_ID}`);
    expect(harness.pushPayloads).toHaveLength(0);
    expect(harness.apnsPayloads).toHaveLength(0);
  });

  it('suppresses a partial marker that still carries the kind and the run id', async () => {
    const harness = createHarness({
      normal: { id: ADVISOR_ID, title: 'Advisor fork', metadata: { openchamber: { kind: 'consult-advisor', consultRunID: 'run_1' } } },
      settings: { notifyOnSubtasks: true },
    });

    await harness.runtime.maybeSendPushForTrigger(completionPayload(ADVISOR_ID));

    expect(harness.pushPayloads).toHaveLength(0);
  });

  it('does not suppress on the kind alone: a marker missing the run id is not an advisor', async () => {
    const harness = createHarness({
      normal: { id: SESSION_ID, title: 'Normal session', metadata: { openchamber: { kind: 'consult-advisor' } } },
      settings: { notifyOnSubtasks: true },
    });

    await harness.runtime.maybeSendPushForTrigger(completionPayload(SESSION_ID));

    expect(harness.pushPayloads).toHaveLength(1);
  });

  it('classifies a fork from a session event without another fetch', async () => {
    const harness = createHarness();

    await harness.runtime.maybeSendPushForTrigger({
      type: 'session.updated',
      properties: { sessionID: ADVISOR_ID, info: advisorSession },
    });
    await harness.runtime.maybeSendPushForTrigger(completionPayload(ADVISOR_ID));

    expect(harness.pushPayloads).toHaveLength(0);
    expect(harness.fetchedPaths).toEqual([]);
  });
});

describe('ordinary session notifications', () => {
  it('pushes a completion for an ordinary session', async () => {
    const harness = createHarness();

    await harness.runtime.maybeSendPushForTrigger(completionPayload(SESSION_ID));

    expect(harness.pushPayloads).toHaveLength(1);
    expect(harness.pushPayloads[0].tag).toBe(`ready-${SESSION_ID}`);
    expect(harness.pushPayloads[0].data.type).toBe('ready');
    expect(harness.apnsPayloads).toHaveLength(1);
  });

  it('pushes a question for an ordinary session after the debounce', async () => {
    const harness = createHarness();

    await harness.runtime.maybeSendPushForTrigger(questionPayload(SESSION_ID));
    await waitForDebounce();

    expect(harness.fetchedPaths).toContain(`/session/${SESSION_ID}`);
    expect(harness.pushPayloads).toHaveLength(1);
    expect(harness.pushPayloads[0].tag).toBe(`question-${SESSION_ID}`);
  });

  it('keeps btw and review sessions on the normal notification path', async () => {
    for (const kind of ['btw', 'review']) {
      const harness = createHarness({
        normal: { ...normalSession, metadata: { openchamber: { kind } } },
      });

      await harness.runtime.maybeSendPushForTrigger(completionPayload(SESSION_ID));

      expect(harness.pushPayloads).toHaveLength(1);
    }
  });

  it('still suppresses ordinary subtasks when subtask notifications are off', async () => {
    const subtask = createHarness({
      normal: { ...normalSession, parentID: 'ses_parent' },
      settings: { notifyOnSubtasks: false },
    });

    await subtask.runtime.maybeSendPushForTrigger(completionPayload(SESSION_ID));

    expect(subtask.pushPayloads).toHaveLength(0);

    const root = createHarness({ settings: { notifyOnSubtasks: false } });
    await root.runtime.maybeSendPushForTrigger(completionPayload(SESSION_ID));

    expect(root.pushPayloads).toHaveLength(1);
  });
});

describe('malformed advisor metadata', () => {
  it('never throws and keeps the session on the normal notification path', async () => {
    const malformedMetadata = [
      undefined,
      null,
      'consult-advisor',
      ['consult-advisor'],
      { openchamber: 'consult-advisor' },
      { openchamber: ['consult-advisor'] },
      { openchamber: { kind: 42 } },
      { openchamber: { kind: 'Consult-Advisor' } },
      { openchamber: { kind: 'consult-advisor ' } },
      { openchamber: { kind: 'consult-advisor', consultRunID: 7 } },
      { openchamber: { kind: 'consult-advisor', consultRunID: '  ' } },
    ];

    for (const metadata of malformedMetadata) {
      const harness = createHarness({ normal: { id: SESSION_ID, title: 'Normal session', metadata } });

      await harness.runtime.maybeSendPushForTrigger(completionPayload(SESSION_ID));

      expect(harness.pushPayloads).toHaveLength(1);
    }
  });
});
