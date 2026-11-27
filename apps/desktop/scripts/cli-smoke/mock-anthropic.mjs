/**
 * zeenha fork: Mock the Anthropic Messages API on loopback to verify the built
 * CLI's Node runtime floor without real credentials or external requests.
 */
import { once } from 'node:events';
import { createServer } from 'node:http';

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendStream(response, message) {
  const [block] = message.content;
  const isTool = block.type === 'tool_use';
  const events = [
    {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: isTool ? { ...block, input: {} } : { ...block, text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: isTool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    },
    { type: 'message_stop' },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

/** The script receives the parsed body and a mutable state object shared across calls. */
export async function startMockAnthropic({ script }) {
  const requests = [];
  const state = {};
  const server = createServer(async (request, response) => {
    const path = request.url.split('?')[0];
    const headers = { ...request.headers };
    delete headers['x-api-key'];
    delete headers.authorization;
    const isMessages = request.method === 'POST' && (path === '/v1/messages' || path === '/messages');
    const entry = { method: request.method, path, headers, body: null, status: isMessages ? 200 : 404 };
    requests.push(entry);
    const id = requests.length;

    try {
      request.setEncoding('utf8');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      if (raw) entry.body = JSON.parse(raw);
    } catch {
      if (isMessages) entry.status = 400;
    }

    if (entry.status === 404) {
      sendJson(response, 404, { type: 'error', error: { type: 'not_found_error', message: 'Unexpected mock route' } });
      return;
    }
    if (entry.status === 400 || !entry.body || typeof entry.body !== 'object' || Array.isArray(entry.body)) {
      entry.status = 400;
      sendJson(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Expected a JSON object' } });
      return;
    }

    try {
      const { text, toolUse } = await script(entry.body, state);
      const message = {
        id: `msg_smoke_${id}`,
        type: 'message',
        role: 'assistant',
        model: entry.body.model,
        content: toolUse
          ? [{ type: 'tool_use', id: `toolu_smoke_${id}`, name: toolUse.name, input: toolUse.input }]
          : [{ type: 'text', text }],
        stop_reason: toolUse ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      if (entry.body.stream === true) sendStream(response, message);
      else sendJson(response, 200, message);
    } catch {
      entry.status = 500;
      if (response.headersSent) {
        response.destroy();
      } else {
        sendJson(response, 500, { type: 'error', error: { type: 'api_error', message: 'Mock response script failed' } });
      }
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closing;
  return {
    // Aperant passes this prefix through to the SDK, which appends /messages.
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
