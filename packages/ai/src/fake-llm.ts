import type { CompletionRequest, CompletionResult, LLMProvider } from './providers.js';

/** Scripted LLM for tests and local dev: returns queued responses in order (§10.5 fakes). */
export class FakeLLMProvider implements LLMProvider {
  readonly name = 'fake-llm';
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly responses: string[] = []) {}

  queue(...responses: string[]): this {
    this.responses.push(...responses);
    return this;
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const text = this.responses.shift();
    if (text === undefined)
      return Promise.reject(new Error('FakeLLMProvider has no queued response'));
    return Promise.resolve({
      text,
      model: 'fake-model',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 1,
    });
  }
}
