// Deterministic protocol fixture. This is not an AI model or a competition demo.
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { TrueForgeRunner } from '../src/trueforge';
import { startEditorBridge } from '../src/mcp';

async function main() {
  let mode = 'success';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.model === 'broken') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Synthetic invalid key', type: 'authentication_error' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'wait') { res.write(': waiting\n\n'); return; }
    const emit = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant', content: '' });
    const toolReplies = body.messages.filter((message: { role: string }) => message.role === 'tool').length;
    if (mode === 'approval' && toolReplies < 3) {
      const retrieval = body.tools.find((tool: { function: { name: string } }) => tool.function.name.includes('retrieve_context'));
      assert.ok(retrieval, 'Deferred retrieval tool is present');
      const mcp_server = retrieval.function.description.split('\n')[0].replace('mcp server: ', '');
      const name = ['list_tools', 'get_tool_info', 'call_tool'][toolReplies];
      const args = { mcp_server, ...(toolReplies > 0 ? { tool_name: 'propose_edit' } : {}), ...(toolReplies === 2 ? { input: { path: 'fixture.ts', oldText: 'before', newText: 'after' } } : {}) };
      emit({ tool_calls: [{ index: 0, id: `fixture-${toolReplies}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      emit({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    emit({ content: 'Protocol fixture completed.' });
    emit({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const name = `forge-fixture-${Date.now()}`;
  const client = new TrueForge({ baseUrl: 'http://localhost:8792', maxRetries: 0 });
  const bridge = await startEditorBridge(async () => 'fixture');
  try {
    await client.settings.modelProviders.create({ manifest: { type: 'custom', name, baseUrl: `http://127.0.0.1:${address.port}/v1`, auth: { apiKey: 'local-test-only' }, models: ['working', 'broken'].map(model => ({ name: model, modelId: model, properties: { contextLength: 32000, maxOutputTokens: 4096 } })) } });
    const events: string[] = [];
    const options = { baseUrl: 'http://localhost:8792', model: `${name}/working`, prompt: 'Say protocol fixture completed.', mcpUrl: bridge.url, mcpToken: bridge.token, signal: new AbortController().signal, onEvent: (event: { type: string }) => { events.push(event.type); }, onApproval: async () => true, onRetry: () => {} };
    const runner = new TrueForgeRunner({ retryDelayMs: 10 });
    const result = await runner.run(options);
    assert.match(result.output, /Protocol fixture completed/);
    assert.ok(events.includes('model.message.delta'));
    console.log('PASS actual TrueForge session and streamed response');
    mode = 'approval';
    let approvals = 0;
    await runner.run({ ...options, onApproval: async request => { assert.equal(request.name, 'propose_edit'); assert.equal(request.args.oldText, 'before'); approvals++; return true; } });
    assert.equal(approvals, 1);
    console.log('PASS TrueForge approval and resumed tool turn');
    mode = 'success';
    let retries = 0;
    const fallback = await runner.run({ ...options, model: `${name}/broken`, fallbackModel: `${name}/working`, onRetry: () => { retries++; } });
    assert.equal(fallback.model, `${name}/working`);
    assert.equal(retries, 2);
    console.log('PASS provider failure, retry, and automatic fallback');
    mode = 'wait';
    const abort = new AbortController();
    const pending = runner.run({ ...options, signal: abort.signal, onEvent: event => { if (event.type === 'turn.created') setTimeout(() => abort.abort(), 200); } });
    await assert.rejects(pending);
    console.log('PASS in-flight cancellation');
  } finally {
    await client.settings.modelProviders.delete(name).catch(() => {});
    await bridge.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
