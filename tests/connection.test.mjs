import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker.mjs';

const env = { SITE_ORIGIN: 'https://fixture.workers.dev' };
const rpc = (body) =>
  new Request(env.SITE_ORIGIN + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });

test('stateless MCP initialization and discovery advertise OAuth for all tools', async () => {
  const init = await handle(
    rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'connection-test', version: '1' },
      },
    }),
    env,
  );
  assert.equal(init.status, 200);
  assert.equal(init.headers.has('mcp-session-id'), false);
  const initialization = await init.json();
  assert.equal(initialization.result.protocolVersion, '2025-03-26');
  assert.equal(initialization.result.serverInfo.version, '1.0.0');
  assert.ok(initialization.result.instructions.includes('取得済み原本を再利用'));
  const notification = await handle(
    rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    env,
  );
  assert.equal(notification.status, 202);
  const response = await handle(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), env);
  const list = await response.json();
  assert.equal(list.result.tools.length, 17);
  const readFile = list.result.tools.find((tool) => tool.name === 'read_file');
  assert.deepEqual(Object.keys(readFile.inputSchema.properties).sort(), ['course_id', 'file_id']);
  assert.ok(readFile.description.includes('prepare_request'));
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.securitySchemes, [
      {
        type: 'oauth2',
        scopes: [tool.name === 'get_web_session' ? 'scombz:session' : 'scombz:read'],
      },
    ]);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
  }
});

test('missing OAuth access token returns a linking challenge without using ScombZ', async () => {
  let upstream = 0;
  const response = await handle(
    rpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_connection_status', arguments: {} },
    }),
    env,
    {
      fetch: async () => {
        upstream++;
        throw new Error('unexpected');
      },
    },
  );
  assert.equal(response.status, 401);
  const challenge = response.headers.get('www-authenticate');
  assert.ok(
    challenge.includes(
      'resource_metadata="https://fixture.workers.dev/.well-known/oauth-protected-resource/mcp"',
    ),
  );
  assert.ok(challenge.includes('scope="scombz:read"'));
  const body = await response.json();
  assert.equal(body.id, 7);
  assert.equal(body.result.isError, true);
  assert.deepEqual(body.result._meta['mcp/www_authenticate'], [challenge]);
  assert.equal(upstream, 0);
});

test('unsupported streaming and invalid RPC bodies produce client errors', async () => {
  const get = await handle(new Request(env.SITE_ORIGIN + '/mcp'), env);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  for (const body of [null, 3, 'invalid']) assert.equal((await handle(rpc(body), env)).status, 400);
});
