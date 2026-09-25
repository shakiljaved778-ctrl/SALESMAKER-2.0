import { z } from 'zod';

import type { CompletionRequest, CompletionResult, LLMProvider } from './providers.js';

export interface AIUsageRecord {
  promptRef: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  attempt: number;
  outcome: 'ok' | 'invalid_output' | 'provider_error';
}

export class AIOutputInvalidError extends Error {
  constructor(
    readonly promptRef: string,
    readonly issues: string,
  ) {
    super(`AI output for ${promptRef} failed validation after a retry`);
    this.name = 'AIOutputInvalidError';
  }
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return JSON.parse((fenced?.[1] ?? text).trim()) as unknown;
}

/**
 * The single entry point for model calls (§8.1). Every call is metered through `onUsage`.
 * `structured()` validates the model's JSON against a zod schema and retries once with the
 * validation error; if it still fails, it throws AIOutputInvalidError so the UI can fall back.
 * LLM output is data: nothing here executes it (golden rule 4).
 */
export class AIGateway {
  constructor(
    private readonly llm: LLMProvider,
    private readonly onUsage: (record: AIUsageRecord) => void = () => undefined,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      const result = await this.llm.complete(request);
      this.record(request, result, 1, 'ok');
      return result;
    } catch (error) {
      this.onUsage({
        promptRef: request.promptRef,
        model: this.llm.name,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        attempt: 1,
        outcome: 'provider_error',
      });
      throw error;
    }
  }

  async structured<T extends z.ZodType>(
    schema: T,
    request: CompletionRequest,
  ): Promise<z.infer<T>> {
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
    const system = `${request.system}\n\nRespond with only a JSON value that matches this JSON Schema:\n${jsonSchema}`;
    let messages = request.messages;
    let lastIssues = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.llm.complete({ ...request, system, messages });
      let parsed: z.ZodSafeParseResult<z.infer<T>>;
      try {
        parsed = schema.safeParse(extractJson(result.text));
      } catch {
        parsed = {
          success: false,
          error: new z.ZodError([
            { code: 'custom', path: [], message: 'Output was not valid JSON', input: result.text },
          ]),
        } as z.ZodSafeParseResult<z.infer<T>>;
      }
      this.record(request, result, attempt, parsed.success ? 'ok' : 'invalid_output');
      if (parsed.success) return parsed.data;
      lastIssues = z.prettifyError(parsed.error);
      messages = [
        ...messages,
        { role: 'assistant', content: result.text },
        {
          role: 'user',
          content: `That output did not validate:\n${lastIssues}\nReturn corrected JSON only.`,
        },
      ];
    }
    throw new AIOutputInvalidError(request.promptRef, lastIssues);
  }

  private record(
    request: CompletionRequest,
    result: CompletionResult,
    attempt: number,
    outcome: AIUsageRecord['outcome'],
  ) {
    this.onUsage({
      promptRef: request.promptRef,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      attempt,
      outcome,
    });
  }
}
