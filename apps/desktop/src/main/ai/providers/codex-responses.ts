import { type LanguageModelMiddleware, parseJsonEventStream, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import type { ThinkingLevel } from '../config/types';

export const CODEX_RESPONSES_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_RESPONSES_URL = `${CODEX_RESPONSES_BASE_URL}/responses`;

const codexOptions = (reasoningEffort?: ThinkingLevel): LanguageModelMiddleware => ({
  specificationVersion: 'v3',
  async transformParams({ params }) {
    const openai = params.providerOptions?.openai;
    const systemMessages = params.prompt.flatMap(message => message.role === 'system' ? [message.content] : []);
    const instructions = [openai?.instructions, ...systemMessages]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
    return {
      ...params,
      // The subscription endpoint streams and controls its own output budget.
      maxOutputTokens: undefined,
      temperature: undefined,
      topP: undefined,
      prompt: params.prompt.filter(message => message.role !== 'system'),
      providerOptions: {
        ...params.providerOptions,
        openai: {
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...openai,
          instructions: instructions || 'You are a helpful assistant.',
          store: false,
        },
      },
    };
  },
});

export function configureCodexModel(model: Parameters<typeof wrapLanguageModel>[0]['model'], reasoningEffort?: ThinkingLevel) {
  return wrapLanguageModel({ model, middleware: codexOptions(reasoningEffort) });
}

const codexEvent = z.object({
  type: z.string(),
  response: z.record(z.string(), z.unknown()).optional(),
  message: z.string().optional(),
  code: z.string().optional(),
});

/** The AI SDK's generateText expects JSON. Codex supplies the full response in its terminal SSE event. */
export async function readCodexResponse(response: Response): Promise<Response> {
  if (!response.ok || !response.body) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');

  const reader = parseJsonEventStream({ stream: response.body, schema: codexEvent }).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.success) continue;
      const event = value.value;
      if (event.type === 'error') {
        return Response.json({ error: { message: event.message ?? 'Codex response failed', code: event.code } }, { status: 400, headers });
      }
      if (event.response && ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
        return Response.json(event.response, { headers });
      }
    }
  } finally {
    await reader.cancel();
  }
  return Response.json({ error: { message: 'Codex ended the stream before returning a response' } }, { status: 502, headers });
}
