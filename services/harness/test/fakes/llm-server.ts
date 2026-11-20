// OpenAI-compatible (DeepSeek chat/completions, streaming) stand-in. The harness uses its REAL pi pipeline
// (createLlm({ baseUrl })), so requests are serialised by pi-ai's openai-completions adapter exactly as in production;
// raw request bodies are recorded for the golden tests.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ScriptedReply {
  readonly thinking?: string;
  readonly text?: string;
  readonly toolCalls?: readonly { readonly name: string; readonly args: unknown; readonly id?: string }[];
  /** default: tool_calls when toolCalls present, else stop */
  readonly finish?: 'stop' | 'tool_calls' | 'length';
  /** HTTP error instead of a stream */
  readonly status?: number;
  /** never answer (request-timeout tests) */
  readonly hang?: boolean;
  /** split text/thinking into chunks of this size (default 7) */
  readonly chunk?: number;
}

export type Script = (body: ChatRequest, index: number) => ScriptedReply;

export interface ChatRequest {
  model: string;
  messages: {
    role: string;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: string;
    reasoning_content?: string;
  }[];
  tools?: unknown[];
  max_tokens?: number;
  [k: string]: unknown;
}

export class FakeLlmServer {
  readonly requests: { raw: string; body: ChatRequest }[] = [];
  private server: Server | undefined;
  baseUrl = '';
  script: Script = () => ({ text: 'ok' });
  private callSeq = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    const a = this.server.address();
    if (a === null || typeof a === 'string') throw new Error('no address');
    this.baseUrl = `http://127.0.0.1:${a.port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(raw) as ChatRequest;
    const index = this.requests.length;
    this.requests.push({ raw, body });
    const reply = this.script(body, index);
    if (reply.hang) return; // keep the socket open
    if (reply.status !== undefined) {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'scripted failure', type: 'server_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = `chatcmpl-${index}`;
    const send = (delta: Record<string, unknown>, finish: string | null = null): void => {
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    };
    const size = reply.chunk ?? 7;
    send({ role: 'assistant', content: '' });
    for (const part of split(reply.thinking ?? '', size)) send({ reasoning_content: part });
    for (const part of split(reply.text ?? '', size)) send({ content: part });
    (reply.toolCalls ?? []).forEach((tc, i) => {
      const callId = tc.id ?? `call_${this.callSeq++}`;
      send({ tool_calls: [{ index: i, id: callId, type: 'function', function: { name: tc.name, arguments: '' } }] });
      send({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(tc.args) } }] });
    });
    const finish = reply.finish ?? ((reply.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop');
    send({}, finish);
    const promptTokens = Math.ceil(raw.length / 4);
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 20,
          total_tokens: promptTokens + 20,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: promptTokens,
          completion_tokens_details: { reasoning_tokens: reply.thinking ? 5 : 0 },
        },
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

function split(s: string, n: number): string[] {
  const out: string[] = [];
  const cps = [...s];
  for (let i = 0; i < cps.length; i += n) out.push(cps.slice(i, i + n).join(''));
  return out;
}
