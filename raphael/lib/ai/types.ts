export type ChatRole = "user" | "assistant" | "system" | "tool";

/** A function-call request carried by an assistant message (OpenAI wire shape). */
export interface ChatMessageToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * A single conversation turn.
 *
 * OpenAI-compatible shape so any provider speaking the chat-completions
 * dialect can round-trip it unchanged:
 * - assistant messages may carry `tool_calls` when they request tool use;
 * - tool messages carry `tool_call_id` pointing at the call they answer.
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: ChatMessageToolCall[];
  tool_call_id?: string;
}

/** Tool a model may call, declared in the OpenAI `tools` wire format. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema describing the function arguments. */
    parameters: Record<string, unknown>;
  };
}

/** A tool call the model made, with its arguments already JSON-parsed. */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Raw arguments string exactly as the model emitted it. */
  rawArguments: string;
}

/** Result of executing a single tool call (safe text for the model). */
export interface ToolResult {
  call: ParsedToolCall;
  ok: boolean;
  output: string;
}

/**
 * A unit of the assistant stream:
 * - "text" — a chunk of markdown/text the client renders;
 * - "reasoning" — a reasoning/thinking delta (never rendered to the user;
 *   used only so callers know the model responded);
 * - "tool_calls" — the model requested these tool calls (emitted once all
 *   calls of the turn are known; the caller must run them and continue).
 */
export type AIStreamChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_calls"; calls: ParsedToolCall[] };

export interface StreamChatOptions {
  signal?: AbortSignal;
  /** Tool definitions sent to the provider. Omit for chat-only calls. */
  tools?: ToolDefinition[];
  /** Output token cap sent as `max_tokens` (0/undefined = unset). */
  maxTokens?: number;
  /** Wall-clock timeout for establishing the connection (ms). */
  timeoutMs?: number;
  /** Idle timeout between stream chunks (ms). 0 = disabled. */
  idleTimeoutMs?: number;
}

/**
 * Minimal provider abstraction.
 *
 * Every AI backend the agent talks to implements this single interface.
 * Swapping models/providers later means adding another implementation
 * in lib/ai/provider.ts — nothing else in the app changes.
 */
export interface AIProvider {
  /** Human-readable name, used in logs/errors (never leaks secrets). */
  name: string;
  /**
   * Send a full conversation and receive the assistant reply as a
   * stream of chunks (text and/or tool calls).
   */
  streamChat(
    messages: ChatMessage[],
    options?: StreamChatOptions
  ): AsyncGenerator<AIStreamChunk, void, unknown>;
}

/** Error with a safe, user-presentable message and an HTTP status hint. */
export class AIProviderError extends Error {
  status: number;
  /** Machine-readable category: timeout | network | provider | malformed | empty | rate_limited | auth */
  code?: string;
  constructor(message: string, status = 502, code?: string) {
    super(message);
    this.name = "AIProviderError";
    this.status = status;
    this.code = code;
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
