/**
 * Mock OpenAI-compatible provider for the Phase 0 consult probe.
 *
 * Localhost only. It never talks to a real provider and needs no credentials;
 * the apiKey sent by OpenCode is a literal probe string. Every chat-completion
 * request is recorded verbatim (headers redacted, body raw + parsed) so the
 * probe can make claims from observed request bodies only.
 *
 * Reply selection is keyword based so scenarios stay robust against extra
 * provider calls (titles, retries): the probe embeds unique tokens in the
 * prompt it sends and this server reacts to them.
 */

const nowSeconds = () => Math.floor(Date.now() / 1000);

function sseChunk({ id, model, delta, finishReason = null, usage }) {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model,
    choices: finishReason === null && usage
      ? []
      : [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('\n');
  }
  return '';
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messageText(messages[index].content);
  }
  return '';
}

function hasToolResult(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some((message) => {
    if (message?.role === 'tool') return true;
    if (Array.isArray(message?.content)) {
      return message.content.some((part) => part?.type === 'tool-result');
    }
    return false;
  });
}

export function defaultReply(body) {
  const text = lastUserText(body);
  const model = typeof body?.model === 'string' ? body.model : 'unknown-model';
  // Once the tool result is in the conversation, answer in text. Without this
  // the mock would keep re-emitting the same tool call and loop until the
  // server's internal retry limit turns it into an unrelated storage error.
  const toolAlreadyAnswered = hasToolResult(body);
  if (!toolAlreadyAnswered && text.includes('PROBE_TOOLCALL_BASH')) {
    return { toolCall: { name: 'bash', arguments: { command: 'printf probe > probe-bash-file.txt' } } };
  }
  if (!toolAlreadyAnswered && text.includes('PROBE_TOOLCALL_WRITE')) {
    return { toolCall: { name: 'write', arguments: { filePath: 'probe-write-file.txt', content: 'probe' } } };
  }
  if (!toolAlreadyAnswered && text.includes('PROBE_TOOLCALL_EDIT')) {
    return { toolCall: { name: 'edit', arguments: { filePath: 'seed.txt', oldString: 'seed', newString: 'mutated' } } };
  }
  if (!toolAlreadyAnswered && text.includes('PROBE_TOOLCALL_PATCH')) {
    return { toolCall: { name: 'patch', arguments: { filePath: 'seed.txt', diff: '--- a/seed.txt\n+++ b/seed.txt\n@@\n-seed\n+patched\n' } } };
  }
  if (!toolAlreadyAnswered && text.includes('PROBE_TOOLCALL_TASK')) {
    return { toolCall: { name: 'task', arguments: { description: 'probe subagent', prompt: 'probe subagent prompt', subagent_type: 'general' } } };
  }
  if (!toolAlreadyAnswered && text.includes('PROBE_TOOLCALL_QUESTION')) {
    return { toolCall: { name: 'question', arguments: { questions: [{ question: 'probe question?', header: 'probe', options: [{ label: 'yes', description: 'yes' }] }] } } };
  }
  if (text.includes('PROBE_TOOLCALL_')) {
    return { text: `probe-reply-after-tool model=${model}` };
  }
  return { text: `probe-reply model=${model} to=${text.slice(0, 160)}` };
}

export function startMockProvider() {
  const requests = [];
  const scripted = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname.endsWith('/models')) {
        return Response.json({
          object: 'list',
          data: [
            { id: 'mock-model', object: 'model', created: nowSeconds(), owned_by: 'probe' },
            { id: 'other-model', object: 'model', created: nowSeconds(), owned_by: 'probe' },
          ],
        });
      }

      if (!url.pathname.endsWith('/chat/completions')) {
        return Response.json(
          { error: { message: `mock provider: unhandled route ${request.method} ${url.pathname}` } },
          { status: 404 },
        );
      }

      const raw = await request.text();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }

      const record = {
        seq: requests.length + 1,
        at: new Date().toISOString(),
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(
          [...request.headers.entries()].map(([key, value]) => [
            key,
            key.toLowerCase() === 'authorization' ? '<redacted-probe-key>' : value,
          ]),
        ),
        body,
        raw,
      };
      requests.push(record);

      const reply = scripted.length > 0
        ? scripted.shift()(body, record)
        : defaultReply(body);
      const model = typeof body?.model === 'string' ? body.model : 'mock-model';
      const id = `chatcmpl-probe-${record.seq}`;

      if (body?.stream === false) {
        return Response.json({
          id,
          object: 'chat.completion',
          created: nowSeconds(),
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: reply.toolCall ? null : reply.text,
              ...(reply.toolCall
                ? {
                  tool_calls: [{
                    id: `call_probe_${record.seq}`,
                    type: 'function',
                    function: {
                      name: reply.toolCall.name,
                      arguments: JSON.stringify(reply.toolCall.arguments),
                    },
                  }],
                }
                : {}),
            },
            finish_reason: reply.toolCall ? 'tool_calls' : 'stop',
          }],
          usage: USAGE,
        });
      }

      const parts = [sseChunk({ id, model, delta: { role: 'assistant', content: '' } })];
      if (reply.toolCall) {
        parts.push(sseChunk({
          id,
          model,
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_probe_${record.seq}`,
              type: 'function',
              function: {
                name: reply.toolCall.name,
                arguments: JSON.stringify(reply.toolCall.arguments),
              },
            }],
          },
        }));
        parts.push(sseChunk({ id, model, delta: {}, finishReason: 'tool_calls' }));
      } else {
        parts.push(sseChunk({ id, model, delta: { content: reply.text } }));
        parts.push(sseChunk({ id, model, delta: {}, finishReason: 'stop' }));
      }
      if (body?.stream_options?.include_usage) {
        parts.push(sseChunk({ id, model, delta: {}, usage: USAGE }));
      }
      parts.push('data: [DONE]\n\n');

      return new Response(parts.join(''), {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    requests,
    /** Queue one scripted reply; receives (body, record) and returns defaultReply-like shape. */
    queueReply(replyFactory) {
      scripted.push(replyFactory);
    },
    clearQueue() {
      scripted.length = 0;
    },
    stop() {
      return server.stop(true);
    },
  };
}
