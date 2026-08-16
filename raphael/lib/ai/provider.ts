import {
  AIProvider,
  AIProviderError,
  ModelUnavailableError,
  ChatMessage,
  StreamChatOptions,
  AIStreamChunk,
  ParsedToolCall,
} from "./types";

/**
 * OpenAI-compatible chat-completions provider for Ryzumi AI.
 *
 * Ryzumi exposes an OpenAI-compatible Chat Completions interface, so this
 * implementation reuses the standard OpenAI streaming wire format.
 *
 * Configured via environment variables (see README):
 *   RYZUMI_API_KEY   - secret key (server-side only, required)
 *   RYZUMI_BASE_URL  - Ryzumi API base URL (required, no default)
 *
 * The model is chosen per request and passed to getProvider(model); it is
 * validated by the chat route against the model registry before it reaches
 * this provider. No model id is hardcoded here.
 */

const REQUEST_TIMEOUT_MS = 60_000;

/** Upstream error patterns that mean "this model is not usable right now". */
const MODEL_UNAVAILABLE_PATTERNS = [
  /model\b.*\bnot found\b/i,
  /model_not_found/i,
  /no such model/i,
  /unknown model/i,
  /invalid model/i,
  /model.*does not exist/i,
  /model.*is not available/i,
  /model.*unavailable/i,
  /model.*out of stock/i,
  /model.*out-of-stock/i,
  /out of stock/i,
  /insufficient stock/i,
  /sold out/i,
  /has been retired/i,
  /has been deprecated/i,
];

function looksLikeModelUnavailable(body: string): boolean {
  return MODEL_UNAVAILABLE_PATTERNS.some((re) => re.test(body));
}

class RyzumiProvider implements AIProvider {
  name = "ryzumi";

  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(apiKey: string, baseUrl: string, model: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
  }

  async *streamChat(
    messages: ChatMessage[],
    options?: StreamChatOptions
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = options?.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new AIProviderError("The AI provider timed out.", 504);
      }
      if (err instanceof Error && err.name === "AbortError") {
        return; // client disconnected — stop silently
      }
      throw new AIProviderError("Could not reach the AI provider.", 502);
    }

    if (!res.ok) {
      // Read the body ONLY to classify the failure — the raw body may
      // contain internal details and is never forwarded to the client.
      let bodyText = "";
      try {
        bodyText = (await res.text()).slice(0, 4096);
      } catch {
        bodyText = "";
      }

      if (looksLikeModelUnavailable(bodyText)) {
        // Treat upstream model-not-found / out-of-stock as availability
        // information so the client can disable the model and refresh.
        throw new ModelUnavailableError(this.model);
      }

      if (res.status === 401 || res.status === 403) {
        throw new AIProviderError(
          "The AI provider rejected the server credentials.",
          502
        );
      }
      if (res.status === 429) {
        throw new AIProviderError(
          "The AI provider is rate-limiting requests. Please try again shortly.",
          429
        );
      }
      throw new AIProviderError(
        `The AI provider returned an error (status ${res.status}).`,
        502
      );
    }

    if (!res.body) {
      throw new AIProviderError("The AI provider returned an empty response.");
    }

    // Parse the SSE stream of chat.completion.chunk objects.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Tool calls arrive incrementally across chunks, keyed by `index`.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    try {
      let streamEnded = false;
      while (!streamEnded) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            streamEnded = true;
            break;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // tolerate malformed keep-alive lines
          }
          const text = extractDeltaText(parsed);
          if (text) yield { type: "text", text };
          mergeToolCallDelta(parsed, toolCalls);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit the complete set of tool calls once the turn is done so callers
    // can execute them and continue the conversation.
    if (toolCalls.size > 0) {
      const calls: ParsedToolCall[] = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, tc]) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
          name: tc.name || "",
          rawArguments: tc.args,
          arguments: parseToolArguments(tc.args),
        }));
      yield { type: "tool_calls", calls };
    }
  }
}

function extractDeltaText(chunk: unknown): string | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { delta?: { content?: unknown } };
  const content = first?.delta?.content;
  return typeof content === "string" ? content : null;
}

interface AccumToolCall {
  id: string;
  name: string;
  args: string;
}

/** Merge incremental `delta.tool_calls` fragments into the accumulator. */
function mergeToolCallDelta(chunk: unknown, acc: Map<number, AccumToolCall>): void {
  if (typeof chunk !== "object" || chunk === null) return;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const delta = (choices[0] as { delta?: { tool_calls?: unknown } })?.delta
    ?.tool_calls;
  if (!Array.isArray(delta)) return;

  for (const raw of delta) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as { index?: unknown; id?: unknown; function?: unknown };
    if (typeof item.index !== "number") continue;
    const fn = (item.function ?? null) as
      | { name?: unknown; arguments?: unknown }
      | null;

    let entry = acc.get(item.index);
    if (!entry) {
      entry = { id: "", name: "", args: "" };
      acc.set(item.index, entry);
    }
    if (typeof item.id === "string" && item.id) entry.id = item.id;
    if (fn && typeof fn.name === "string" && fn.name) entry.name = fn.name;
    if (fn && typeof fn.arguments === "string") entry.args += fn.arguments;
  }
}

/** Parse a tool-call arguments string; anything malformed becomes {}. */
function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Factory: returns a configured Ryzumi provider for the given model id, or
 * throws a safe error if the server is missing configuration. The model id
 * is passed exactly as configured and must be validated by the caller.
 */
export function getProvider(model: string): AIProvider {
  const apiKey = process.env.RYZUMI_API_KEY;
  if (!apiKey) {
    throw new AIProviderError(
      "The server is not configured with a Ryzumi API key.",
      503
    );
  }
  const baseUrl = process.env.RYZUMI_BASE_URL;
  if (!baseUrl) {
    throw new AIProviderError(
      "The server is not configured with a Ryzumi API base URL.",
      503
    );
  }
  return new RyzumiProvider(apiKey, baseUrl, model);
}
