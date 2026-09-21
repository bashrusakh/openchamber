#!/usr/bin/env bun
/**
 * Consult Models — Phase 0 probe (plan §3, scenarios A1–A9).
 *
 * Run:  bun scripts/consult-probe/run-probe.mjs [--with-web-proxy]
 *
 * What it does:
 * 1. starts a localhost OpenAI-compatible mock provider that records every
 *    request body (no real credentials, no external network);
 * 2. starts the pinned local `opencode serve` binary with an inline config
 *    (`OPENCODE_CONFIG_CONTENT`) whose only provider points at the mock;
 * 3. drives sessions/forks/prompts through the OpenCode HTTP API while
 *    capturing the SSE event stream, provider request bodies, message state,
 *    and a filesystem snapshot of the throwaway workspace;
 * 4. writes the raw evidence to `scripts/consult-probe/evidence/`.
 *
 * Claims are only made from observed request bodies, SSE events, API reads,
 * or filesystem state.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMockProvider } from './mock-provider.mjs';
import { createIsolatedHome, startOpencodeServer } from './opencode-server.mjs';

const SCRIPT_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const BINARY = process.env.CONSULT_PROBE_OPENCODE_BIN
  || path.join(os.homedir(), '.opencode', 'bin', 'opencode');
const WITH_WEB_PROXY = process.argv.includes('--with-web-proxy');

const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function binVersion(binary) {
  try {
    const result = Bun.spawnSync([binary, '--version']);
    return result.stdout.toString().trim();
  } catch (error) {
    return `unknown (${String(error)})`;
  }
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function buildConfig(mockUrl) {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    model: 'mock/mock-model',
    small_model: 'mock/mock-model',
    // Explicit allow removes uncertainty introduced by interactive approvals.
    permission: { bash: 'allow', edit: 'allow', write: 'allow', patch: 'allow' },
    provider: {
      mock: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Consult Probe Mock',
        options: {
          baseURL: `${mockUrl}/v1`,
          apiKey: 'probe-not-a-real-key',
        },
        models: {
          'mock-model': {
            name: 'Mock Model',
            tool_call: true,
            limit: { context: 128000, output: 8192 },
          },
          'other-model': {
            name: 'Other Mock Model',
            tool_call: true,
            limit: { context: 128000, output: 8192 },
          },
        },
      },
    },
    agent: { title: { disable: true } },
  };
}

function createApi(baseUrl, directory) {
  const scoped = (route) => {
    if (!directory) return route;
    const separator = route.includes('?') ? '&' : '?';
    return `${route}${separator}directory=${encodeURIComponent(directory)}`;
  };
  return {
    async request(method, route, body) {
      const response = await fetch(`${baseUrl}${scoped(route)}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed, text };
    },
  };
}

function startSse(baseUrl, events) {
  const controller = new AbortController();
  const done = (async () => {
    try {
      const response = await fetch(`${baseUrl}/event`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        events.push({ at: new Date().toISOString(), sseError: `status ${response.status}` });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              events.push({ at: new Date().toISOString(), event: JSON.parse(payload) });
            } catch {
              events.push({ at: new Date().toISOString(), raw: payload });
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        events.push({ at: new Date().toISOString(), sseError: String(error) });
      }
    }
  })();
  return { stop: () => controller.abort(), done };
}

function snapshotDir(root) {
  const output = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const stat = statSync(full);
        output[path.relative(root, full)] = {
          size: stat.size,
          sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
        };
      }
    }
  };
  walk(root);
  return output;
}

function toolNames(request) {
  const tools = request?.body?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => tool?.function?.name).filter(Boolean).sort();
}

function eventType(entry) {
  return String(entry?.event?.type ?? entry?.event?.payload?.type ?? '');
}

const observations = [];
function observe(claim, ok, detail) {
  const item = { claim, ok: Boolean(ok), detail };
  observations.push(item);
  return item;
}

async function main() {
  const startedAt = new Date().toISOString();
  const runRoot = mkdtempSync(path.join(os.tmpdir(), 'consult-probe-'));
  const workspace = path.join(runRoot, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'seed.txt'), 'seed\n');

  const mock = startMockProvider();
  const isolatedHome = createIsolatedHome(runRoot);
  const config = buildConfig(mock.url);
  const evidence = {
    probe: 'consult-models/phase-0',
    runId,
    startedAt,
    finishedAt: null,
    withWebProxy: WITH_WEB_PROXY,
    versions: {
      opencodeBinary: BINARY,
      opencode: binVersion(BINARY),
      bun: Bun.version,
      appSdkPin: readJsonIfPresent(path.join(REPO_ROOT, 'packages', 'ui', 'package.json'))
        ?.dependencies?.['@opencode-ai/sdk'] ?? null,
    },
    environment: {
      runRoot,
      workspace,
      isolatedHome: isolatedHome.home,
      opensNoRealCredentials: true,
    },
    config,
    mockProvider: { url: mock.url },
    opencode: null,
    scenarios: {},
    observations,
    sseEvents: [],
    providerRequests: [],
  };

  const scenario = (id, payload) => {
    evidence.scenarios[id] = payload;
  };

  let server = null;
  let sse = null;
  const events = evidence.sseEvents;

  try {
    server = await startOpencodeServer({
      binary: BINARY,
      cwd: workspace,
      config,
      isolatedHome,
    });
    evidence.opencode = { baseUrl: server.baseUrl, port: server.port };
    sse = startSse(server.baseUrl, events);

    const api = createApi(server.baseUrl, workspace);

    const findRequest = (token) => mock.requests.find((request) => request.raw.includes(token));
    const sessionErrorEvents = (sessionID) => events.filter(
      (entry) => eventType(entry) === 'session.error'
        && entry?.event?.properties?.sessionID === sessionID,
    );
    const createSession = async (title) => {
      const response = await api.request('POST', '/session', { title });
      if (response.status >= 400) {
        throw new Error(`session create failed (${response.status}): ${response.text}`);
      }
      return response.body;
    };
    const waitForAssistant = async (sessionID, token, timeoutMs = 60000) => {
      const deadline = Date.now() + timeoutMs;
      let lastSnapshot = null;
      while (Date.now() < deadline) {
        const response = await api.request('GET', `/session/${sessionID}/message`);
        if (response.status === 200 && Array.isArray(response.body)) {
          lastSnapshot = response.body;
          const userIndex = response.body.findIndex(
            (entry) => JSON.stringify(entry?.parts ?? []).includes(token),
          );
          if (userIndex >= 0) {
            for (let index = userIndex + 1; index < response.body.length; index += 1) {
              const entry = response.body[index];
              if (entry?.info?.role === 'assistant' && entry.info.time?.completed) {
                return { state: 'completed', assistant: entry, messages: response.body };
              }
            }
          }
        }
        const errors = sessionErrorEvents(sessionID);
        if (errors.length > 0) {
          return {
            state: 'error',
            errors: errors.map((entry) => entry.event.properties.error),
            messages: lastSnapshot,
          };
        }
        await Bun.sleep(200);
      }
      return { state: 'timeout', messages: lastSnapshot };
    };
    const sendAndWait = async (sessionID, body, token, timeoutMs = 60000) => {
      const posted = await api.request('POST', `/session/${sessionID}/prompt_async`, body);
      if (posted.status >= 400) {
        return { state: 'rejected', posted };
      }
      const waited = await waitForAssistant(sessionID, token, timeoutMs);
      return { ...waited, posted };
    };
    const sessionIDOf = (entry) => entry?.sessionID ?? entry?.event?.properties?.sessionID ?? null;

    // ---------------------------------------------------------------- A1/A2
    const parent = await createSession('probe-parent');
    const turn1Token = `PROBE_A1_TURN1_${runId}`;
    const actingToken = `PROBE_A1_ACTING_${runId}`;
    const nextToken = `PROBE_A1_NEXT_${runId}`;
    const systemMarker = `PROBE_SYSTEM_MARKER_${runId}`;

    const turn1 = await sendAndWait(parent.id, {
      model: { providerID: 'mock', modelID: 'mock-model' },
      parts: [{ type: 'text', text: turn1Token }],
    }, turn1Token);

    const acting = await sendAndWait(parent.id, {
      model: { providerID: 'mock', modelID: 'mock-model' },
      system: systemMarker,
      parts: [{ type: 'text', text: actingToken }],
    }, actingToken);

    const next = await sendAndWait(parent.id, {
      model: { providerID: 'mock', modelID: 'mock-model' },
      parts: [{ type: 'text', text: nextToken }],
    }, nextToken);

    const requestTurn1 = findRequest(turn1Token);
    const requestActing = findRequest(actingToken);
    const requestNext = findRequest(nextToken);
    const toolsTurn1 = toolNames(requestTurn1);
    const toolsActing = toolNames(requestActing);

    const actingUserMessage = (acting.messages ?? []).find(
      (entry) => entry?.info?.role === 'user'
        && JSON.stringify(entry?.parts ?? []).includes(actingToken),
    );
    const turn1UserMessage = (turn1.messages ?? []).find(
      (entry) => entry?.info?.role === 'user'
        && JSON.stringify(entry?.parts ?? []).includes(turn1Token),
    );

    observe('A1 acting provider request contains the turn system marker', requestActing?.raw.includes(systemMarker), {
      requestSeq: requestActing?.seq,
    });
    observe('A1 next normal provider request does not contain the marker', requestNext ? !requestNext.raw.includes(systemMarker) : null, {
      requestSeq: requestNext?.seq,
    });
    observe('A1 the marker lives on the acting user message only', actingUserMessage?.info?.system === systemMarker
      && turn1UserMessage?.info?.system === undefined, {
      actingSystem: actingUserMessage?.info?.system ?? null,
      turn1System: turn1UserMessage?.info?.system ?? null,
    });
    observe('A2 acting turn keeps its normal tool set', toolsActing.length > 0
      && JSON.stringify(toolsActing) === JSON.stringify(toolsTurn1), {
      toolsTurn1,
      toolsActing,
    });

    // Parent tool execution control proves tools really run for a normal turn.
    const toolControlToken = `PROBE_A2_TOOLCALL_${runId}`;
    const toolControl = await sendAndWait(parent.id, {
      model: { providerID: 'mock', modelID: 'mock-model' },
      parts: [{ type: 'text', text: `${toolControlToken} PROBE_TOOLCALL_BASH` }],
    }, toolControlToken);
    await Bun.sleep(500);
    observe('A2 parent bash tool call executed in the workspace', existsSync(path.join(workspace, 'probe-bash-file.txt')), {
      toolControlState: toolControl.state,
    });
    observe('A2 parent session did not gain a session-level permission from the hint', (await api.request('GET', `/session/${parent.id}`)).body?.permission === undefined, null);

    scenario('A1', {
      systemMarker,
      actingRequestSeq: requestActing?.seq ?? null,
      nextRequestSeq: requestNext?.seq ?? null,
      actingRequestContainsMarker: requestActing ? requestActing.raw.includes(systemMarker) : null,
      nextRequestContainsMarker: requestNext ? requestNext.raw.includes(systemMarker) : null,
      actingUserMessageSystem: actingUserMessage?.info?.system ?? null,
      turn1UserMessageSystem: turn1UserMessage?.info?.system ?? null,
    });
    scenario('A2', {
      toolsTurn1,
      toolsActing,
      toolsEqual: JSON.stringify(toolsActing) === JSON.stringify(toolsTurn1),
      parentToolExecutionFile: existsSync(path.join(workspace, 'probe-bash-file.txt')),
      parentPermissionAfterTurns: (await api.request('GET', `/session/${parent.id}`)).body?.permission ?? null,
    });

    // -------------------------------------------------------------------- A8
    const metadataToken = `PROBE_A8_METADATA_${runId}`;
    const receiptMarker = `PROBE_RECEIPT_${runId}`;
    const a8Turn = await sendAndWait(parent.id, {
      model: { providerID: 'mock', modelID: 'mock-model' },
      parts: [{
        type: 'text',
        text: metadataToken,
        metadata: { probeReceipt: { runID: receiptMarker, value: 'bounded' } },
      }],
    }, metadataToken);
    const requestA8 = findRequest(metadataToken);
    const a8UserMessage = (a8Turn.messages ?? []).find(
      (entry) => entry?.info?.role === 'user'
        && JSON.stringify(entry?.parts ?? []).includes(metadataToken),
    );
    const a8TextPart = (a8UserMessage?.parts ?? []).find(
      (part) => part?.type === 'text' && part?.text?.includes(metadataToken),
    );
    observe('A8 part metadata is not serialized to the provider request', requestA8 ? !requestA8.raw.includes(receiptMarker) : null, {
      requestSeq: requestA8?.seq,
    });
    observe('A8 part metadata survives the API read back', a8TextPart?.metadata?.probeReceipt?.runID === receiptMarker, {
      metadata: a8TextPart?.metadata ?? null,
    });

    const postA8Token = `PROBE_A8_AFTER_${runId}`;
    await sendAndWait(parent.id, {
      model: { providerID: 'mock', modelID: 'mock-model' },
      parts: [{ type: 'text', text: postA8Token }],
    }, postA8Token);
    const afterA8 = await api.request('GET', `/session/${parent.id}/message`);
    const afterA8Part = (Array.isArray(afterA8.body) ? afterA8.body : [])
      .flatMap((entry) => entry?.parts ?? [])
      .find((part) => part?.type === 'text' && part?.text?.includes(metadataToken));
    observe('A8 part metadata still present after a later turn', afterA8Part?.metadata?.probeReceipt?.runID === receiptMarker, {
      metadata: afterA8Part?.metadata ?? null,
    });
    scenario('A8', {
      receiptMarker,
      providerRequestContainsMarker: requestA8 ? requestA8.raw.includes(receiptMarker) : null,
      metadataReadBack: a8TextPart?.metadata ?? null,
      metadataAfterLaterTurn: afterA8Part?.metadata ?? null,
    });

    // -------------------------------------------------------------- A3/A4/A6
    const forkResponse = await api.request('POST', `/session/${parent.id}/fork`, {});
    const fork = forkResponse.body;
    const forkMessages = await api.request('GET', `/session/${fork.id}/message`);
    const forkClonedPart = (Array.isArray(forkMessages.body) ? forkMessages.body : [])
      .flatMap((entry) => entry?.parts ?? [])
      .find((part) => part?.type === 'text' && part?.text?.includes(metadataToken));
    observe('A8 part metadata travels with the transcript into a fork (risk 12)',
      forkClonedPart?.metadata?.probeReceipt?.runID === receiptMarker, {
      metadata: forkClonedPart?.metadata ?? null,
    });
    scenario('A8', {
      ...evidence.scenarios.A8,
      forkClonedMetadata: forkClonedPart?.metadata ?? null,
    });
    const parentChildren = await api.request('GET', `/session/${parent.id}/children`);
    const denyAllRuleset = [{ permission: '*', pattern: '*', action: 'deny' }];
    const permissionPatch = await api.request('PATCH', `/session/${fork.id}`, {
      permission: denyAllRuleset,
    });
    const forkAfterPatch = await api.request('GET', `/session/${fork.id}`);

    const advisorSystem = `PROBE_ADVISOR_SYSTEM_${runId}`;
    const advisorToken = `PROBE_A3_ADVISOR_${runId}`;
    const preAdvisorSnapshot = snapshotDir(workspace);
    const sessionsBeforeAdvisor = (await api.request('GET', '/session')).body ?? [];
    const eventIndexBeforeAdvisor = events.length;

    const advisor = await sendAndWait(fork.id, {
      model: { providerID: 'mock', modelID: 'mock-model' },
      system: advisorSystem,
      parts: [{ type: 'text', text: `${advisorToken} PROBE_TOOLCALL_WRITE PROBE_TOOLCALL_EDIT PROBE_TOOLCALL_PATCH PROBE_TOOLCALL_TASK PROBE_TOOLCALL_QUESTION` }],
    }, advisorToken, 60000);
    await Bun.sleep(1000);

    const requestAdvisor = findRequest(advisorToken);
    const toolsAdvisor = toolNames(requestAdvisor);
    const postAdvisorSnapshot = snapshotDir(workspace);
    const sessionsAfterAdvisor = (await api.request('GET', '/session')).body ?? [];
    const advisorEvents = events.slice(eventIndexBeforeAdvisor);
    const advisorPermissionEvents = advisorEvents.filter(
      (entry) => eventType(entry).includes('permission')
        && (sessionIDOf(entry) === null || sessionIDOf(entry) === fork.id),
    );
    const advisorQuestionEvents = advisorEvents.filter((entry) => eventType(entry).includes('question'));
    const advisorToolParts = advisorEvents
      .filter((entry) => entry?.event?.type === 'message.part.updated'
        && entry.event.properties?.part?.type === 'tool')
      .map((entry) => ({
        tool: entry.event.properties.part.tool,
        callID: entry.event.properties.part.callID,
        status: entry.event.properties.part.state?.status ?? null,
        error: entry.event.properties.part.state?.error ?? null,
        input: entry.event.properties.part.state?.input ?? null,
      }));
    const advisorErrors = sessionErrorEvents(fork.id).map((entry) => entry.event.properties.error);
    const advisorProviderRequests = mock.requests.filter((request) => request.raw.includes(advisorToken));

    observe('A3 advisor provider request exposes no tools at all',
      requestAdvisor != null && toolsAdvisor.length === 0, {
      tools: toolsAdvisor,
      requestSeq: requestAdvisor?.seq ?? null,
    });
    observe('A3 scripted mutation tool calls are rejected as unavailable tools',
      advisorToolParts.length > 0
        && advisorToolParts.every((part) => part.status === 'error'
          && String(part.error).includes('unavailable tool')), {
      toolParts: advisorToolParts,
    });
    observe('A3 filesystem snapshot unchanged across the advisor run',
      JSON.stringify(preAdvisorSnapshot) === JSON.stringify(postAdvisorSnapshot), {
        before: preAdvisorSnapshot,
        after: postAdvisorSnapshot,
      });
    observe('A3 advisor scripted mutation tool calls produced no workspace files',
      !existsSync(path.join(workspace, 'probe-write-file.txt'))
        && readFileSync(path.join(workspace, 'seed.txt'), 'utf8') === 'seed\n', null);
    observe('A3 no subagent session was created by the advisor turn',
      sessionsAfterAdvisor.length === sessionsBeforeAdvisor.length
        && !sessionsAfterAdvisor.some((entry) => entry.parentID === fork.id), {
      before: sessionsBeforeAdvisor.length,
      after: sessionsAfterAdvisor.length,
    });
    observe('A4 no permission events for the advisor session', advisorPermissionEvents.length === 0, {
      permissionEvents: advisorPermissionEvents,
    });
    observe('A3 no question surfaced for the advisor session', advisorQuestionEvents.length === 0, {
      questionEvents: advisorQuestionEvents,
    });
    observe('A6 fork has no parentID (subtask filters cannot hide it)', fork?.parentID === undefined, {
      parentID: fork?.parentID ?? null,
    });
    observe('A6 parent children listing does not include the fork',
      Array.isArray(parentChildren.body) && !parentChildren.body.some((entry) => entry?.id === fork.id), {
        children: (parentChildren.body ?? []).map((entry) => entry?.id),
        forkID: fork?.id,
      });

    scenario('A3', {
      advisorSystemMarkerPresent: requestAdvisor ? requestAdvisor.raw.includes(advisorSystem) : null,
      requestSeq: requestAdvisor?.seq ?? null,
      toolsAdvisor,
      advisorTurnState: advisor.state,
      assistantError: advisor.assistant?.info?.error ?? null,
      assistantText: (advisor.assistant?.parts ?? [])
        .filter((part) => part?.type === 'text')
        .map((part) => part.text)
        .join('\n'),
      preAdvisorSnapshot,
      postAdvisorSnapshot,
      fsUnchanged: JSON.stringify(preAdvisorSnapshot) === JSON.stringify(postAdvisorSnapshot),
      sessionsBeforeAdvisor: sessionsBeforeAdvisor.length,
      sessionsAfterAdvisor: sessionsAfterAdvisor.length,
      advisorToolParts,
      advisorErrors,
      advisorProviderRequestCount: advisorProviderRequests.length,
    });
    scenario('A4', {
      permissionEvents: advisorPermissionEvents,
      eventCount: advisorEvents.length,
    });
    scenario('A6', {
      forkID: fork?.id ?? null,
      forkParentID: fork?.parentID ?? null,
      parentChildren: (parentChildren.body ?? []).map((entry) => entry?.id),
      permissionPatchStatus: permissionPatch.status,
      forkPermissionAfterPatch: forkAfterPatch.body?.permission ?? null,
    });

    // A9 end-to-end: the session.update permission payload round-trips.
    observe('A9 session.update stored the wildcard deny-all ruleset',
      JSON.stringify(forkAfterPatch.body?.permission ?? null) === JSON.stringify(denyAllRuleset), {
      stored: forkAfterPatch.body?.permission ?? null,
    });

    // A6 hiding prerequisites: metadata marker round-trip, delete isolation.
    const marker = {
      openchamber: {
        kind: 'consult-advisor',
        originalSessionID: parent.id,
        consultRunID: runId,
        advisorIndex: 0,
      },
    };
    await api.request('PATCH', `/session/${fork.id}`, { metadata: marker });
    const forkAfterMetadata = await api.request('GET', `/session/${fork.id}`);
    const parentMessagesBeforeDelete = await api.request('GET', `/session/${parent.id}/message`);
    const deleteFork = await api.request('DELETE', `/session/${fork.id}`);
    const parentAfterDelete = await api.request('GET', `/session/${parent.id}`);
    const parentMessagesAfterDelete = await api.request('GET', `/session/${parent.id}/message`);

    observe('A6 fork metadata marker round-trips through the API',
      forkAfterMetadata.body?.metadata?.openchamber?.kind === 'consult-advisor', {
      metadata: forkAfterMetadata.body?.metadata ?? null,
    });
    observe('A6 deleting the fork does not affect the parent',
      deleteFork.status < 400
        && parentAfterDelete.status === 200
        && JSON.stringify(parentMessagesBeforeDelete.body) === JSON.stringify(parentMessagesAfterDelete.body), {
      deleteStatus: deleteFork.status,
      parentStatus: parentAfterDelete.status,
    });

    scenario('A6', {
      ...evidence.scenarios.A6,
      markerRoundTrip: forkAfterMetadata.body?.metadata ?? null,
      deleteForkStatus: deleteFork.status,
      parentAfterDeleteStatus: parentAfterDelete.status,
      parentMessagesStable:
        JSON.stringify(parentMessagesBeforeDelete.body) === JSON.stringify(parentMessagesAfterDelete.body),
      notificationsObserved: false,
      notificationsNote: 'plain opencode serve has no OpenChamber notification runtime; '
        + 'suppression is a WP1.5 server-side test, not observable in this harness',
    });

    // -------------------------------------------------------------------- A5
    const providers = await api.request('GET', '/config/providers');
    const listedModels = (providers.body?.providers ?? [])
      .filter((provider) => provider?.id === 'mock')
      .flatMap((provider) => Object.keys(provider?.models ?? {}));

    const a5ModelToken = `PROBE_A5_MODEL_${runId}`;
    const a5ModelSession = await createSession('probe-a5-model');
    const a5ModelBefore = mock.requests.length;
    const a5Model = await sendAndWait(a5ModelSession.id, {
      model: { providerID: 'mock', modelID: 'does-not-exist' },
      parts: [{ type: 'text', text: a5ModelToken }],
    }, a5ModelToken, 15000);
    await Bun.sleep(500);
    const a5ModelRequest = mock.requests.slice(a5ModelBefore).find((request) => request.raw.includes(a5ModelToken));

    const a5AgentToken = `PROBE_A5_AGENT_${runId}`;
    const a5AgentSession = await createSession('probe-a5-agent');
    const a5AgentBefore = mock.requests.length;
    const a5Agent = await sendAndWait(a5AgentSession.id, {
      model: { providerID: 'mock', modelID: 'mock-model' },
      agent: 'no-such-agent',
      parts: [{ type: 'text', text: a5AgentToken }],
    }, a5AgentToken, 15000);
    await Bun.sleep(500);
    const a5AgentRequest = mock.requests.slice(a5AgentBefore).find((request) => request.raw.includes(a5AgentToken));

    const a5VariantToken = `PROBE_A5_VARIANT_${runId}`;
    const a5VariantSession = await createSession('probe-a5-variant');
    const a5VariantBefore = mock.requests.length;
    const a5Variant = await sendAndWait(a5VariantSession.id, {
      model: { providerID: 'mock', modelID: 'mock-model' },
      variant: 'no-such-variant',
      parts: [{ type: 'text', text: a5VariantToken }],
    }, a5VariantToken, 15000);
    await Bun.sleep(500);
    const a5VariantRequest = mock.requests.slice(a5VariantBefore).find((request) => request.raw.includes(a5VariantToken));

    const a5ModelErrorText = JSON.stringify(a5Model.errors ?? []);
    const a5AgentErrorText = JSON.stringify(a5Agent.errors ?? []);

    observe('A5 unknown model is rejected with an explicit reason and never reaches the provider',
      !a5ModelRequest
        && a5ModelErrorText.includes('Model not found')
        && (a5Model.state === 'error' || a5Model.state === 'rejected'), {
      state: a5Model.state,
      httpStatus: a5Model.posted?.status ?? null,
      providerModel: a5ModelRequest?.body?.model ?? null,
      errors: a5Model.errors ?? null,
    });
    observe('A5 unknown agent is rejected with an explicit reason and never reaches the provider',
      !a5AgentRequest
        && a5AgentErrorText.includes('Agent not found')
        && (a5Agent.state === 'error' || a5Agent.state === 'rejected'), {
      state: a5Agent.state,
      httpStatus: a5Agent.posted?.status ?? null,
      providerReached: Boolean(a5AgentRequest),
      errors: a5Agent.errors ?? null,
    });
    // The pinned server does not validate variants: an unknown variant is
    // dropped without an error and the turn runs with no variant. Phase 1 must
    // therefore validate the exact variant at start (plan §4 step 1).
    observe('A5 unknown variant is not silently substituted by the server (server-level claim)',
      a5VariantRequest === undefined
        || a5VariantRequest.body?.variant === 'no-such-variant'
        || a5Variant.state === 'rejected', {
      state: a5Variant.state,
      httpStatus: a5Variant.posted?.status ?? null,
      providerVariant: a5VariantRequest?.body?.variant ?? null,
      providerReached: Boolean(a5VariantRequest),
      errors: a5Variant.errors ?? null,
      serverBehavior: 'unknown variant dropped, turn ran on the plain model',
    });

    scenario('A5', {
      listedMockModels: listedModels,
      unknownModel: {
        state: a5Model.state,
        httpStatus: a5Model.posted?.status ?? null,
        responseBody: a5Model.posted?.body ?? null,
        providerReached: Boolean(a5ModelRequest),
        providerModel: a5ModelRequest?.body?.model ?? null,
        errors: a5Model.errors ?? null,
      },
      unknownAgent: {
        state: a5Agent.state,
        httpStatus: a5Agent.posted?.status ?? null,
        responseBody: a5Agent.posted?.body ?? null,
        providerReached: Boolean(a5AgentRequest),
        errors: a5Agent.errors ?? null,
      },
      unknownVariant: {
        state: a5Variant.state,
        httpStatus: a5Variant.posted?.status ?? null,
        responseBody: a5Variant.posted?.body ?? null,
        providerReached: Boolean(a5VariantRequest),
        providerVariant: a5VariantRequest?.body?.variant ?? null,
        errors: a5Variant.errors ?? null,
        serverBehavior: 'unknown variant dropped, turn ran on the plain model',
      },
    });

    // -------------------------------------------------------------------- A7
    if (WITH_WEB_PROXY) {
      try {
        const { probeWebProxy } = await import('./web-proxy.mjs');
        const proxyResult = await probeWebProxy({
          repoRoot: REPO_ROOT,
          opencodeBaseUrl: server.baseUrl,
          workspace,
          runId,
          mock,
          isolatedHome,
        });
        scenario('A7', proxyResult);
      } catch (error) {
        scenario('A7', {
          status: 'not-verified',
          error: String(error),
          stack: error?.stack ?? null,
        });
      }
    } else {
      scenario('A7', {
        status: 'not-verified',
        error: 'web proxy scenario not requested (run with --with-web-proxy); '
          + 'VS Code bridge is not runnable outside the extension host',
      });
    }

    evidence.observations = observations;
  } finally {
    if (sse) {
      sse.stop();
      await Promise.race([sse.done, Bun.sleep(2000)]);
    }
    if (server) await server.stop();
    mock.stop();
    evidence.finishedAt = new Date().toISOString();
    evidence.providerRequests = mock.requests;
    if (server) evidence.opencode = { ...evidence.opencode, logs: server.logs.join('') };

    const evidenceDir = path.join(SCRIPT_DIR, 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    const evidenceFile = path.join(evidenceDir, `phase-0-${runId}.json`);
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence written to ${path.relative(REPO_ROOT, evidenceFile)}`);

    const failed = observations.filter((item) => item.ok === false);
    const unknown = observations.filter((item) => item.ok === null);
    for (const item of observations) {
      const flag = item.ok === true ? 'PASS' : item.ok === false ? 'FAIL' : 'NOT-VERIFIED';
      console.log(`[${flag}] ${item.claim}`);
    }
    console.log(`\nClaims: ${observations.length - failed.length - unknown.length} pass, ${failed.length} fail, ${unknown.length} not-verified`);
    console.log(`OpenCode: ${evidence.versions.opencode} (bin) / app pin sdk ${evidence.versions.appSdkPin}`);
    if (failed.length > 0) process.exitCode = 1;
  }
}

await main();
