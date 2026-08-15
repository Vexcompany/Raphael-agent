import { AIProvider, AIProviderError, ChatMessage } from "./types";

/**
 * OpenAI-compatible chat-completions provider.
 *
 * Works with any service exposing the OpenAI Chat Completions API:
 * OpenAI, OpenRouter, Groq, DeepSeek, Together, local gateways, etc.
 *
 * Configured entirely via environment variables (see README):
 *   AI_API_KEY   - secret key (server-side only, required)
 *   AI_BASE_URL  - API base URL (default: https://api.openai.com/v1)
 *   AI_MODEL     - model id   (default: gpt-4o-mini)
 */

const REQUEST_TIMEOUT_MS = 60_000;

class OpenAICompatibleProvider implements AIProvider {
  name = "openai-compatible";

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
    signal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
        }),
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
      // Never forward the provider's raw body to the client — it can
      // contain internal details. Map to a safe message instead.
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // tolerate malformed keep-alive lines
          }
          const delta = extractDelta(parsed);
          if (delta) yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function extractDelta(chunk: unknown): string | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { delta?: { content?: unknown } };
  const content = first?.delta?.content;
  return typeof content === "string" ? content : null;
}

/**
 * Factory: returns the configured provider or throws a safe error if
 * the server is missing configuration.
 */
export function getProvider(): AIProvider {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    throw new AIProviderError(
      "The server is not configured with an AI API key.",
      503
    );
  }
  const baseUrl = process.env.AI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.AI_MODEL || "gpt-4o-mini";
  return new OpenAICompatibleProvider(apiKey, baseUrl, model);
}
