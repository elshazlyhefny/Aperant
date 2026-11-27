/**
 * zeenha fork: Test the credential-free fixtures used to verify the built CLI's
 * Node runtime floor. Run with npm run test:cli-smoke from apps/desktop.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFixtureRepo, worktreeSpecDir } from './fixture-repo.mjs';
import { startMockAnthropic } from './mock-anthropic.mjs';

const model = 'claude-smoke';
const toolUse = { name: 'Write', input: { file_path: 'fixture.txt', content: 'Smoke output' } };
const headers = {
  'Content-Type': 'application/json',
  'X-Api-Key': 'fixture-only-key',
  Authorization: 'Bearer fixture-only-token',
};

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
}

async function readEvents(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream\b/);
  const events = (await response.text()).trimEnd().split('\n\n').map((frame) => {
    const [event, data] = frame.split('\n');
    const parsed = JSON.parse(data.slice('data: '.length));
    assert.equal(event, `event: ${parsed.type}`);
    return parsed;
  });
  assert.deepEqual(events.map(({ type }) => type), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  return events;
}

test('mock streams a tool call, returns a JSON message, and records no credential headers', async (t) => {
  const mock = await startMockAnthropic({
    script(_body, state) {
      state.calls = (state.calls ?? 0) + 1;
      return state.calls === 1 ? { toolUse } : { text: `Call ${state.calls}` };
    },
  });
  t.after(() => mock.close());
  assert.equal(new URL(mock.baseUrl).hostname, '127.0.0.1');

  const streamingBody = { model, stream: true, tools: [{ name: toolUse.name }] };
  const events = await readEvents(await post(`${mock.baseUrl}/messages`, streamingBody));
  assert.deepEqual(events[0].message.content, []);
  assert.equal(events[0].message.usage.input_tokens, 10);
  assert.deepEqual(events[1].content_block, { type: 'tool_use', id: 'toolu_smoke_1', name: toolUse.name, input: {} });
  assert.equal(events[2].delta.type, 'input_json_delta');
  assert.deepEqual(JSON.parse(events[2].delta.partial_json), toolUse.input);
  assert.equal(events[4].delta.stop_reason, 'tool_use');
  assert.equal(events[4].usage.output_tokens, 5);

  const jsonBody = { model, stream: false };
  const response = await post(new URL('/messages', mock.baseUrl), jsonBody);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json\b/);
  assert.deepEqual(await response.json(), {
    id: 'msg_smoke_2',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'Call 2' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  assert.deepEqual(mock.requests.map(({ method, path, body, status }) => ({ method, path, body, status })), [
    { method: 'POST', path: '/v1/messages', body: streamingBody, status: 200 },
    { method: 'POST', path: '/messages', body: jsonBody, status: 200 },
  ]);
  for (const request of mock.requests) {
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(Object.hasOwn(request.headers, 'x-api-key'), false);
    assert.equal(Object.hasOwn(request.headers, 'authorization'), false);
  }
});

test('mock streams text and records 404s for unexpected methods and paths', async (t) => {
  const mock = await startMockAnthropic({ script: () => ({ text: 'Smoke output' }) });
  t.after(() => mock.close());

  const events = await readEvents(await post(`${mock.baseUrl}/messages`, { model, stream: true }));
  assert.deepEqual(events[1].content_block, { type: 'text', text: '' });
  assert.deepEqual(events[2].delta, { type: 'text_delta', text: 'Smoke output' });
  assert.equal(events[4].delta.stop_reason, 'end_turn');

  const body = { model };
  const unknownPath = await post(`${mock.baseUrl}/unexpected`, body);
  assert.equal(unknownPath.status, 404);
  await unknownPath.json();
  const wrongMethod = await fetch(`${mock.baseUrl}/messages`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(wrongMethod.status, 404);
  await wrongMethod.json();
  assert.deepEqual(mock.requests.slice(1).map(({ method, path, body, status }) => ({ method, path, body, status })), [
    { method: 'POST', path: '/v1/unexpected', body, status: 404 },
    { method: 'GET', path: '/v1/messages', body: null, status: 404 },
  ]);
});

test('fixture repository has one commit on main and one pending subtask', (t) => {
  const specId = '001-cli-smoke';
  const { repo, specDir, cleanup } = createFixtureRepo({ specId });
  t.after(cleanup);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(repo, realpathSync(repo));
  assert.equal(git('rev-parse', '--is-inside-work-tree'), 'true');
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  assert.equal(git('remote'), '');
  assert.equal(git('check-ignore', `.auto-claude/specs/${specId}/spec.md`), `.auto-claude/specs/${specId}/spec.md`);
  assert.equal(readFileSync(join(repo, '.auto-claude', '.env'), 'utf8'), 'CONTEXT7_ENABLED=false\n');
  assert.match(readFileSync(join(specDir, 'spec.md'), 'utf8'), /^# .+/);

  const plan = JSON.parse(readFileSync(join(specDir, 'implementation_plan.json'), 'utf8'));
  assert.equal(plan.phases.length, 1);
  assert.equal(plan.phases[0].subtasks.length, 1);
  assert.equal(plan.phases[0].subtasks[0].status, 'pending');
  assert.equal(plan.qa_signoff, undefined);
  assert.equal(
    worktreeSpecDir(repo, specId),
    join(repo, '.auto-claude/worktrees/tasks', specId, '.auto-claude/specs', specId),
  );

  cleanup();
  assert.equal(existsSync(repo), false);
});
