import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import agentDefinition from '../trueforge/agent.json';

export interface ApprovalRequest {
  id: string;
  threadId: string;
  sessionId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface RunOptions {
  baseUrl: string;
  model: string;
  fallbackModel?: string;
  prompt: string;
  mcpUrl: string;
  mcpToken: string;
  signal: AbortSignal;
  onEvent: (event: TrueForgeApi.TurnStreamingEvent) => void;
  onApproval: (request: ApprovalRequest) => Promise<boolean>;
  onRetry: (info: { attempt: number; model: string; reason: string }) => void | Promise<void>;
  onSession?: (id: string, model: string) => void;
  onWarning?: (message: string) => void;
}

export interface RunResult {
  sessionId: string;
  model: string;
  output: string;
}

/** Injectable fetch exercises the real SDK's serialization and streaming in tests. */
export interface RunnerOptions {
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

class RunFailure extends Error {
  constructor(message: string, readonly retryable: boolean = true) {
    super(message);
  }
}

export function validateLocalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) {
    throw new Error('TrueForge and editor MCP URLs must use HTTP on localhost.');
  }
  return url.toString().replace(/\/$/, '');
}

export function createAgentSpec(model: string, serverName: string): TrueForgeApi.AgentSpec {
  return {
    ...agentDefinition,
    model: { name: model },
    mcpServers: [{ ...agentDefinition.mcpServers[0], name: serverName }],
  };
}

function safeFailure(error: unknown): RunFailure {
  if (error instanceof RunFailure) return error;
  const status = typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number(error.statusCode) : undefined;
  if (status === 401 || status === 403) {
    return new RunFailure('TrueForge denied access. Check the local server authentication configuration.', false);
  }
  if (status === 400 || status === 422) {
    return new RunFailure('TrueForge rejected the agent configuration. Check the configured model name and server version.', false);
  }
  return new RunFailure(status
    ? `TrueForge request failed (HTTP ${status}).`
    : 'The connection to TrueForge failed or timed out. Check the local server and model endpoint.');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class TrueForgeRunner {
  constructor(private readonly options: RunnerOptions = {}) {}

  async run(options: RunOptions): Promise<RunResult> {
    const baseUrl = validateLocalUrl(options.baseUrl);
    const mcpUrl = validateLocalUrl(options.mcpUrl);
    if (!options.model.trim()) throw new Error('Choose a model configured in TrueForge Settings.');
    if (!options.mcpToken) throw new Error('The editor MCP token is missing.');
    options.signal.throwIfAborted();
    const client = new TrueForge({
      baseUrl,
      timeoutInSeconds: 600,
      maxRetries: 0,
      fetch: this.options.fetch,
      stream: { reconnectionEnabled: false },
    });
    const serverName = `forge-review-${randomUUID()}`;
    // The unique name prevents one editor window from replacing another window's tools.
    let registrationAttempted = false;
    try {
      registrationAttempted = true;
      await client.settings.mcpServers.create({ manifest: {
        name: serverName,
        type: 'remote',
        description: 'VS Code workspace tools with staged, reviewed edits',
        url: mcpUrl,
        auth: { type: 'header', headers: { Authorization: `Bearer ${options.mcpToken}` } },
      } }, { abortSignal: options.signal, timeoutInSeconds: 15 });

      const models = [options.model, options.model];
      if (options.fallbackModel?.trim() && options.fallbackModel !== options.model) {
        models.push(options.fallbackModel);
      }
      let lastFailure: RunFailure | undefined;
      for (let attempt = 0; attempt < models.length; attempt++) {
        options.signal.throwIfAborted();
        const model = models[attempt];
        if (attempt > 0) {
          await options.onRetry({ attempt: attempt + 1, model, reason: lastFailure!.message });
          await delay((this.options.retryDelayMs ?? 750) * 2 ** (attempt - 1), undefined,
            { signal: options.signal });
        }
        try {
          return await this.runSession(client, options, model, serverName);
        } catch (error) {
          options.signal.throwIfAborted();
          lastFailure = safeFailure(error);
          if (!lastFailure.retryable) throw lastFailure;
        }
      }
      throw lastFailure;
    } catch (error) {
      options.signal.throwIfAborted();
      throw safeFailure(error);
    } finally {
      if (registrationAttempted) {
        try {
          await client.settings.mcpServers.delete(serverName, { timeoutInSeconds: 5 });
        } catch {
          options.onWarning?.('TrueForge could not remove its temporary editor connector. It can be removed in TrueForge Settings.');
        }
      }
    }
  }

  private async runSession(client: TrueForge, options: RunOptions, model: string,
    serverName: string): Promise<RunResult> {
    const { data: session } = await client.sessions.create({
      agent: { spec: createAgentSpec(model, serverName) },
    }, { abortSignal: options.signal, timeoutInSeconds: 15 });
    options.onSession?.(session.id, model);
    let finished = false;
    let cancelRequest: Promise<unknown> | undefined;
    const cancel = () => {
      cancelRequest ??= client.sessions.cancel(session.id, {}, { timeoutInSeconds: 5 })
        .catch(() => options.onWarning?.('The server did not confirm cancellation. The editor has discarded the run.'));
    };
    options.signal.addEventListener('abort', cancel, { once: true });
    try {
      options.signal.throwIfAborted();
      let input: TrueForgeApi.TurnInputItem[] = [{ type: 'user.message', content: options.prompt }];
      // A turn ends at an approval boundary. Only TrueForge executes the tool loop.
      for (let turnCount = 0; turnCount < 100; turnCount++) {
        const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
        let terminal: TrueForgeApi.TurnDoneEvent | undefined;
        const stream = await client.sessions.createTurnStream(session.id, { input },
          { abortSignal: options.signal });
        for await (const { data: event } of stream.withMetadata()) {
          options.signal.throwIfAborted();
          if (isEventDelta(event)) {
            const base = events.get(event.id);
            if (base) mergeEventDelta(base, event);
          } else {
            events.set(event.id, event);
          }
          options.onEvent(event);
          if (event.type === 'turn.done') terminal = event;
        }
        if (!terminal) throw new RunFailure('TrueForge disconnected before the turn completed.');
        if (terminal.state.status === 'cancelled') {
          throw new RunFailure('TrueForge cancelled the run.', false);
        }
        if (terminal.state.status === 'error') {
          // Provider errors can contain URLs, credentials or prompts. Keep user-facing errors generic.
          throw new RunFailure('TrueForge could not complete the model request. Check the model configuration and session details.');
        }
        const actions = terminal.state.requiredActions;
        if (!actions.length) {
          finished = true;
          const content = terminal.state.output?.content;
          return { sessionId: session.id, model, output: typeof content === 'string' ? content : '' };
        }
        input = [];
        for (const action of actions) {
          if (action.type !== 'tool.approval_required') {
            throw new RunFailure('TrueForge requires an unsupported interaction. Inspect the session in TrueForge.', false);
          }
          for (const reference of action.toolCalls) {
            const source = events.get(reference.sourceEventId);
            const call = source?.type === 'model.message'
              ? source.toolCalls?.find(item => item.id === reference.id) : undefined;
            if (!call) {
              throw new RunFailure('TrueForge returned an approval without a matching editor tool call.', false);
            }
            let args: unknown;
            try { args = JSON.parse(call.function.arguments); } catch {
              throw new RunFailure('The model produced invalid tool arguments.', false);
            }
            if (!args || Array.isArray(args) || typeof args !== 'object') {
              throw new RunFailure('The model produced invalid tool arguments.', false);
            }
            let toolName = call.toolInfo.name;
            if (call.toolInfo.type === 'truefoundry-system' && toolName === 'call_tool') {
              const deferred = args as Record<string, unknown>;
              if (deferred.mcp_server !== serverName || typeof deferred.tool_name !== 'string' || !deferred.input || typeof deferred.input !== 'object' || Array.isArray(deferred.input)) {
                throw new RunFailure('Invalid deferred editor approval.', false);
              }
              toolName = deferred.tool_name;
              args = deferred.input;
            } else if (call.toolInfo.type !== 'mcp' || call.toolInfo.serverName !== serverName) {
              throw new RunFailure('Approval targets an unknown MCP server.', false);
            }
            let approved: boolean;
            try {
              approved = await abortable(options.onApproval({
                id: reference.id,
                threadId: action.threadId,
                sessionId: session.id,
                name: toolName,
                args: args as Record<string, unknown>,
              }), options.signal);
            } catch {
              options.signal.throwIfAborted();
              throw new RunFailure('The editor could not complete the tool review.', false);
            }
            input.push({ type: 'user.tool_approval', toolCallId: reference.id,
              threadId: action.threadId,
              approval: approved ? { status: 'allow' } : { status: 'deny', reason: 'The user rejected this tool request.' },
            });
          }
        }
      }
      throw new RunFailure('The run reached the approval turn limit. Start a smaller task.', false);
    } finally {
      options.signal.removeEventListener('abort', cancel);
      if (!finished) cancel();
      await cancelRequest;
    }
  }
}
