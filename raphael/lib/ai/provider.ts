import {
  AIProviderError,
  ModelUnavailableError,
} from "./types";
import type {
  AIProvider,
  ChatMessage,
  StreamChatOptions,
  AIStreamChunk,
  ParsedToolCall,
} from "./types";

/**
 * OpenAI-compatible chat-completions provider for Ryzumi AI.
 *
 * Ryzumi exposes an OpenAI-compatible Chat Completions interface, so this
 * implementation reuses the standard OpenAI streaming wire format while
 * tolerating small deviations (reasoning deltas, tool-call chunks without
 * `index`, bare-JSON lines).
 *
 * Configured via environment variables (see README):
 *   RYZUMI_API_KEY        - secret key (server-side only, required)
 *   RYZUMI_BASE_URL       - Ryzumi API base URL (required, no default)
 *   RYZUMI_MAX_TOKENS     - output token cap (default 1024)
 *   RYZUMI_TIMEOUT_MS     - connect timeout in ms (default 30000)
 *   RYZUMI_IDLE_TIMEOUT_MS- max silence between chunks in ms (default 30000)
 *
 * The model is chosen per request and passed to getProvider(model); it is
 * validated by the chat route against the model registry before it reaches
 * this provider. No model id is hardcoded here.
 *
 * Error model (all user-presentable, never raw upstream bodies):
 *   timeout      -> AIProviderError 504 code "timeout"
 *   network      -> AIProviderError 502 code "network"
 *   provider     -> AIProviderError (upstream HTTP error) code "provider"
 *   malformed    -> AIProviderError 502 code "malformed"
 *   rate_limited -> AIProviderError 429 code "rate_limited"
 *   auth         -> AIProviderError 502 code "auth"
 *   model_unavail-> ModelUnavailableError 409 (special-cased by the route)
 *   actual empty -> the generator simply yields nothing; callers distinguish
 *                   "no response at all" from errors.
 *
 * Client-initiated aborts are treated as normal stream end (silent); a
 * provider timeout mid-stream is thrown so partial output is preserved and
 * the caller can surface a truthful error instead of "empty response".
 */

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

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

class RyzumiProvider implements AIProvider {
  name = "ryzumi";

  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private timeoutMs: number;
  private idleTimeoutMs: number;

  constructor(apiKey: string, baseUrl: string, model: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.maxTokens = positiveInt(process.env.RYZUMI_MAX_TOKENS, 1024);
    this.timeoutMs = positiveInt(process.env.RYZUMI_TIMEOUT_MS, 30_000);
    this.idleTimeoutMs = positiveInt(process.env.RYZUMI_IDLE_TIMEOUT_MS, 30_000);
  }

  async *streamChat(
    messages: ChatMessage[],
    options?: StreamChatOptions
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    const maxTokens = options?.maxTokens ?? this.maxTokens;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const idleTimeoutMs = options?.idleTimeoutMs ?? this.idleTimeoutMs;

    // One controller for the whole request; abort reasons are tracked so a
    // provider timeout is never confused with a client disconnect.
    const controller = new AbortController();
    let timedOut = false;
    let clientAborted = false;
    const onClientAbort = () => {
      clientAborted = true;
      controller.abort();
    };
    const clientSignal = options?.signal;
    if (clientSignal) {
      if (clientSignal.aborted) return;
      clientSignal.addEventListener("abort", onClientAbort, { once: true });
    }

    const clearClientListener = () => {
      clientSignal?.removeEventListener("abort", onClientAbort);
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }
    if (maxTokens > 0) {
      body.max_tokens = maxTokens;
    }

    let res: Response;
    try {
      // Connect timeout: how long we wait for the response headers.
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      clearTimer();
      clearClientListener();
      if (timedOut) {
        throw new AIProviderError("The AI provider timed out.", 504, "timeout");
      }
      if (clientAborted) return;
      throw new AIProviderError("Could not reach the AI provider.", 502, "network");
    }
    clearTimer();

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
          502,
          "auth"
        );
      }
      if (res.status === 429) {
        throw new AIProviderError(
          "The AI provider is rate-limiting requests. Please try again shortly.",
          429,
          "rate_limited"
        );
      }
      throw new AIProviderError(
        `The AI provider returned an error (status ${res.status}).`,
        502,
        "provider"
      );
    }

    if (!res.body) {
      // Genuinely empty response body — yield nothing; the caller decides
      // how to present "no response".
      clearClientListener();
      return;
    }

    // Parse the SSE stream of chat.completion.chunk objects.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls = new ToolCallAccumulator();

    let streamEnded = false;
    let sawDelta = false; // any content/reasoning/tool-call delta seen
    let malformedLines = 0;

    try {
      while (!streamEnded) {
        // Idle timeout: abort if no chunk arrives for a while. An actively
        // streaming response is never cut off by a wall-clock deadline.
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, idleTimeoutMs);

        let value: Uint8Array | undefined;
        let done: boolean;
        try {
          ({ value, done } = await reader.read());
        } catch (err) {
          clearTimer();
          if (timedOut) {
            throw new AIProviderError(
              "The AI provider timed out while streaming.",
              504,
              "timeout"
            );
          }
          if (clientAborted) return;
          if (err instanceof Error && err.name === "AbortError") return;
          throw err;
        }
        clearTimer();

        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("event:") || trimmed.startsWith(":")) {
            continue;
          }

          let data: string;
          if (trimmed.startsWith("data:")) {
            data = trimmed.slice(5).trim();
          } else {
            // Some providers emit bare JSON chunks instead of `data:` lines.
            data = trimmed;
          }
          if (!data) continue;
          if (data === "[DONE]") {
            streamEnded = true;
            break;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            malformedLines += 1;
            continue; // tolerate malformed keep-alive lines
          }

          const content = extractDeltaContent(parsed);
          if (content) {
            sawDelta = true;
            yield { type: "text", text: content };
          }
          const reasoning = extractDeltaReasoning(parsed);
          if (reasoning) {
            sawDelta = true;
            yield { type: "reasoning", text: reasoning };
          }
          if (toolCalls.merge(parsed)) {
            sawDelta = true;
          }
        }
      }
    } finally {
      clearTimer();
      clearClientListener();
      reader.releaseLock();
    }

    // Emit the complete set of tool calls once the turn is done so callers
    // can execute them and continue the conversation.
    if (toolCalls.size > 0) {
      const calls: ParsedToolCall[] = toolCalls
        .entries()
        .map((tc) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
          name: tc.name || "",
          rawArguments: tc.args,
          arguments: parseToolArguments(tc.args),
        }));
      yield { type: "tool_calls", calls };
      return;
    }

    // If the stream contained only malformed lines and no real delta, the
    // upstream returned something we could not parse — distinguish this
    // from a genuinely empty (but well-formed) response.
    if (!sawDelta && malformedLines > 0) {
      throw new AIProviderError(
        "The AI provider returned a malformed response.",
        502,
        "malformed"
      );
    }
  }
}

function extractDeltaContent(chunk: unknown): string | null {
  const delta = extractDelta(chunk);
  const content = delta?.content;
  return typeof content === "string" && content ? content : null;
}

/** Reasoning deltas (e.g. `delta.reasoning_content`) — never rendered. */
function extractDeltaReasoning(chunk: unknown): string | null {
  const delta = extractDelta(chunk);
  if (!delta) return null;
  const r = (delta as Record<string, unknown>).reasoning_content ?? (delta as Record<string, unknown>).reasoning;
  return typeof r === "string" && r ? r : null;
}

function extractDelta(chunk: unknown): Record<string, unknown> | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const delta = (choices[0] as { delta?: unknown })?.delta;
  if (typeof delta !== "object" || delta === null) return null;
  return delta as Record<string, unknown>;
}

interface AccumToolCall {
  index: number;
  id: string;
  name: string;
  args: string;
}

/**
 * Robust accumulator for streaming `delta.tool_calls`.
 *
 * Handles the OpenAI shape (numeric `index` on every fragment) and common
 * deviations: fragments without `index` (matched by id/name, or appended to
 * the most recently touched call when only `arguments` arrive), and
 * `index` given as a numeric string.
 */
class ToolCallAccumulator {
  private byIndex = new Map<number, AccumToolCall>();
  private nextIndex = 0;
  private lastTouched: AccumToolCall | null = null;

  get size(): number {
    return this.byIndex.size;
  }

  entries(): AccumToolCall[] {
    return [...this.byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }

  merge(chunk: unknown): boolean {
    if (typeof chunk !== "object" || chunk === null) return false;
    const choices = (chunk as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return false;
    const delta = (choices[0] as { delta?: { tool_calls?: unknown } })?.delta;
    const rawCalls = delta?.tool_calls;
    if (!Array.isArray(rawCalls)) return false;

    let changed = false;
    for (const raw of rawCalls) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const fn = item.function ?? null;
      const hasId = typeof item.id === "string" && item.id.length > 0;
      const hasName = typeof fn?.name === "string" && fn.name.length > 0;
      const hasArgs = typeof fn?.arguments === "string" && fn.arguments.length > 0;

      let entry: AccumToolCall | undefined;

      // 1) Explicit index (number or numeric string).
      const rawIndex =
        typeof item.index === "number"
          ? item.index
          : typeof item.index === "string" && item.index.trim() !== "" &&
            Number.isFinite(Number(item.index))
            ? Number(item.index)
            : undefined;
      if (typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0) {
        entry = this.byIndex.get(rawIndex);
        if (!entry) {
          entry = { index: rawIndex, id: "", name: "", args: "" };
          this.byIndex.set(rawIndex, entry);
        }
      }

      // 2) No usable index: match by id, then by name.
      if (!entry) {
        if (hasId) {
          entry = [...this.byIndex.values()].find((e) => e.id === item.id);
        }
        if (!entry && hasName) {
          entry = [...this.byIndex.values()].find((e) => e.name === fn.name);
        }
      }

      // 3) No index and no identifiers: an args-only fragment continues the
      //    most recently touched call.
      if (!entry && this.lastTouched && !hasId && !hasName && hasArgs) {
        entry = this.lastTouched;
      }

      // 4) Still nothing — a brand new call whose first fragment has no index.
      if (!entry) {
        entry = { index: this.nextIndex++, id: "", name: "", args: "" };
        this.byIndex.set(entry.index, entry);
      }

      if (hasId) entry.id = item.id as string;
      if (hasName) entry.name = fn.name as string;
      if (hasArgs) entry.args += fn.arguments as string;

      this.lastTouched = entry;
      changed = true;
    }
    return changed;
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
