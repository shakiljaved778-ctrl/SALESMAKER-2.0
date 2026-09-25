/**
 * Provider interfaces (§8.1). Model ids always come from configuration (AI_MODEL_FAST,
 * AI_MODEL_SMART, AI_MODEL_DEEP), never from code.
 */
export type ModelTier = 'fast' | 'smart' | 'deep';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  tier: ModelTier;
  /** Trusted instructions. Third-party text never goes here (§8.2). */
  system: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** Prompt registry reference logged with every call: `prompt_id@version`. */
  promptRef: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SpeechProvider {
  readonly name: string;
  transcribe(
    audioUrl: string,
    options: { diarize: boolean; languageHint?: string },
  ): Promise<{
    text: string;
    segments: { speaker: string; startMs: number; endMs: number; text: string }[];
  }>;
}
