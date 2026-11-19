import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js';

const string = { type: 'string' };
function tool(name: string, description: string, properties: Record<string, object>, required: string[]): Tool {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
export const editorTools = [
  tool('list_files', 'List readable workspace files. Discover paths before editing.', {}, []),
  tool('read_file', 'Read current staged content or a workspace file. Reads are bounded.', { path: string }, ['path']),
  tool('search_workspace', 'Search workspace code with a literal query.', { query: string }, ['query']),
  tool('retrieve_context', 'Retrieve ranked code windows within a character budget, with reasons.', { query: string }, ['query']),
  tool('find_symbol', 'Find declarations and references for a symbol in workspace code.', { name: string }, ['name']),
  tool('propose_edit', 'Propose one exact replacement in an existing previously read file. oldText must be non-empty and occur exactly once. Human approval reviews hunks. Re-read after partial acceptance.', { path: string, oldText: string, newText: string }, ['path', 'oldText', 'newText']),
  tool('run_command', 'Run an approved executable with arguments in a temporary workspace copy containing accepted staged changes. No shell expansion. This is not an OS security sandbox.', { command: string, args: { type: 'array', items: string, maxItems: 100 } }, ['command', 'args'])
];

export interface EditorBridge { url: string; token: string; close(): Promise<void> }
export async function startEditorBridge(call: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<EditorBridge> {
  const token = randomBytes(32).toString('hex');
  const transports = new Set<StreamableHTTPServerTransport>();
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const auth = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected) || req.headers.origin) {
      res.writeHead(403).end(); return;
    }
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2_000_000) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const server = new Server({ name: 'forge-review-editor', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: editorTools }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const result = await call(request.params.name, request.params.arguments ?? {});
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Editor tool failed.' }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transports.add(transport);
    res.on('close', () => { transports.delete(transport); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
  const http = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); }); });
  http.requestTimeout = 180_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Editor bridge did not bind a port.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, token,
    async close() {
      await Promise.allSettled([...transports].map(transport => transport.close()));
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  };
}
