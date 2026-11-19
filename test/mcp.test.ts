import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startEditorBridge } from '../src/mcp';

test('MCP bridge authenticates and carries editor tool requests over HTTP', async () => {
  const bridge = await startEditorBridge(async (name, args) => ({ name, args }));
  const client = new Client({ name: 'test', version: '1' });
  try {
    assert.equal((await fetch(bridge.url, { method: 'POST' })).status, 403);
    assert.equal((await fetch(bridge.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, Origin: 'https://example.com' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
    const listing = await client.listTools();
    assert.equal(listing.tools.length, 7);
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'src/main.ts' } });
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify({ name: 'read_file', args: { path: 'src/main.ts' } }) }]);
  } finally { await client.close(); await bridge.close(); }
});
