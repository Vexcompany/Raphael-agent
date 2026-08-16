export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Minimal provider abstraction.
 *
 * Every AI backend Raphael talks to implements this single interface.
 * Swapping models/providers later means adding another implementation
 * in lib/ai/provider.ts — nothing else in the app changes.
 */
export interface AIProvider {
  /** Human-readable name, used in logs/errors (never leaks secrets). */
  name: string;
  /**
   * Send a full conversation and receive the assistant reply as a
   * stream of text chunks.
   */
  streamChat(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): AsyncGenerator<string, void, unknown>;
}

/** Error with a safe, user-presentable message and an HTTP status hint. */
export class AIProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "AIProviderError";
    this.status = status;
  }
}

/**
 * The requested model is not available upstream (model-not-found,
 * out-of-stock, retired, etc.). Carries the exact model id so callers can
 * disable it and refresh availability. The message is always safe to show
 * the user — it never contains raw upstream error bodies.
 */
export class ModelUnavailableError extends AIProviderError {
  model: string;
  constructor(model: string, message = "The selected model is currently unavailable.") {
    super(message, 409);
    this.name = "ModelUnavailableError";
    this.model = model;
  }
}
