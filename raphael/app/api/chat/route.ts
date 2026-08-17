import { getProvider } from "@/lib/ai/provider";
import { invalidateModelsCache, validateModel } from "@/lib/ai/models";
import { buildSystemPrompt } from "@/lib/ai/systemPrompt";
import {
  AIProviderError,
  ChatMessage,
  ModelUnavailableError,
} from "@/lib/ai/types";
import { runChat } from "@/lib/agent/runChat";
import { likelyNeedsGitHub } from "@/lib/agent/needsTools";
import { GITHUB_TOOLS } from "@/lib/github/tools";
import { isGitHubConfigured } from "@/lib/github/auth";
import {
  isSummaryFresh,
  summarizeConversation,
} from "@/lib/memory/summarizer";
import {
  MIN_MESSAGES_FOR_SUMMARY,
  RECENT_WINDOW,
  type MemoryPayload,
} from "@/lib/memory/types";
import {
  MEMORY_MARKER,
  MODEL_UNAVAILABLE_MARKER,
  STREAM_ERROR_MARKER,
  TOOL_MARKER,
} from "@/lib/stream/events";

export const runtime = "nodejs";
export const maxDuration = 290; // Hobby max is 300s; leave a small buffer for multi-tool agent runs

const MAX_MESSAGES = 60; // most recent messages kept as context (before memory compaction)
const MAX_MESSAGE_CHARS = 32_000;
const MAX_BODY_BYTES = 1_000_000;

interface ParsedBody {
  messages: ChatMessage[];
  model?: string;
  memory?: MemoryPayload;
}

function badRequest(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function parseMemory(raw: unknown): MemoryPayload | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.summary !== "string" || o.summary.trim() === "") return undefined;
  if (typeof o.summarizedUntil !== "number" || !Number.isFinite(o.summarizedUntil)) {
    return undefined;
  }
  if (typeof o.messageCount !== "number" || !Number.isFinite(o.messageCount)) {
    return undefined;
  }
  return {
    summary: o.summary.trim(),
    summarizedUntil: Math.max(0, Math.floor(o.summarizedUntil)),
    messageCount: Math.max(0, Math.floor(o.messageCount)),
  };
}

/** Strictly validate and sanitize the request body. */
function parseBody(raw: unknown): ParsedBody | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "Request body must be a JSON object." };
  }
  const messages = (raw as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: "Request must include a non-empty 'messages' array." };
  }

  const clean: ChatMessage[] = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) {
      return { error: "Each message must be an object." };
    }
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    // Clients may only send user/assistant turns; the system prompt and any
    // tool/tool_calls messages are controlled by the server.
    if (role !== "user" && role !== "assistant") {
      return { error: "Message role must be 'user' or 'assistant'." };
    }
    if (typeof content !== "string") {
      return { error: "Message content must be a string." };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { error: "A message exceeds the maximum allowed length." };
    }
    clean.push({ role, content });
  }

  const last = clean[clean.length - 1];
  if (last.role !== "user" || last.content.trim().length === 0) {
    return { error: "The last message must be a non-empty user message." };
  }

  // Optional model id. The server resolves the effective model below and
  // validates it against the registry before it reaches the provider.
  const modelRaw = (raw as { model?: unknown }).model;
  let model: string | undefined;
  if (modelRaw !== undefined) {
    if (typeof modelRaw !== "string" || modelRaw.trim() === "") {
      return { error: "Model must be a non-empty string." };
    }
    model = modelRaw;
  }

  const memory = parseMemory((raw as { memory?: unknown }).memory);

  // Keep only the most recent context window before memory compaction.
  const trimmed = clean.slice(-MAX_MESSAGES);
  return { messages: trimmed, model, memory };
}

export async function POST(req: Request): Promise<Response> {
  // Basic body-size guard.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return badRequest("Request body is too large.", 413);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return badRequest(parsed.error);
  }

  // Effective model: client selection wins; otherwise the server-side
  // RYZUMI_MODEL default; otherwise the gateway's "auto" routing.
  const model = parsed.model ?? process.env.RYZUMI_MODEL ?? "auto";

  // Validate the requested model against the current registry before
  // streaming. Arbitrary model ids never reach the upstream provider.
  try {
    await validateModel(model);
  } catch (err) {
    if (err instanceof AIProviderError) {
      const code =
        err.status === 409 ? "model_unavailable" : "model_not_found";
      return Response.json(
        { error: err.message, code, model },
        { status: err.status }
      );
    }
    return Response.json(
      { error: "Could not validate the requested model." },
      { status: 500 }
    );
  }

  let provider;
  try {
    provider = getProvider(model);
  } catch (err) {
    if (err instanceof AIProviderError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "Server configuration error." }, { status: 500 });
  }

  // ── Memory compaction ───────────────────────────────────────────────────
  // Prefer a fresh client-cached summary. Otherwise summarize older turns
  // (best-effort). When a summary is available we only send the recent
  // window to the model, which keeps token usage bounded.
  let memoryOut: MemoryPayload | null = null;
  const clientMemory = parsed.memory;
  const allMessages = parsed.messages;

  if (
    clientMemory &&
    isSummaryFresh(
      allMessages.length,
      clientMemory.summarizedUntil,
      clientMemory.messageCount
    )
  ) {
    memoryOut = clientMemory;
  } else if (allMessages.length >= MIN_MESSAGES_FOR_SUMMARY) {
    try {
      const result = await summarizeConversation(provider, allMessages);
      if (result) {
        memoryOut = {
          summary: result.summary,
          summarizedUntil: result.summarizedUntil,
          messageCount: result.messageCount,
        };
      }
    } catch {
      // Best-effort; fall back to sending recent messages without summary.
      memoryOut = null;
    }
  }

  const recentMessages =
    memoryOut && allMessages.length > RECENT_WINDOW
      ? allMessages.slice(-RECENT_WINDOW)
      : allMessages;

  // GitHub tools are attached only when (a) the server has App credentials
  // and (b) this request plausibly needs them — ordinary chat skips the
  // ~1,600-token tool schema entirely. The system prompt is told the same
  // truth so the model never claims a capability that is not actually
  // available in this turn.
  const githubConnected = isGitHubConfigured();
  const tools =
    githubConnected && likelyNeedsGitHub(parsed.messages) ? GITHUB_TOOLS : [];
  const systemPrompt = buildSystemPrompt({
    githubConnected,
    toolsActive: tools.length > 0,
    memorySummary: memoryOut?.summary,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentMessages,
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let sentAnything = false;
        for await (const event of runChat(provider, messages, tools, {
          signal: req.signal,
        })) {
          if (event.type === "text") {
            sentAnything = true;
            controller.enqueue(encoder.encode(event.text));
          } else {
            // Compact, JSON-safe tool activity line; the client strips it
            // from the rendered markdown. Markers already include leading newlines.
            controller.enqueue(
              encoder.encode(
                `${TOOL_MARKER}${JSON.stringify({ name: event.tool, ok: event.ok })}\n`
              )
            );
          }
        }
        if (!sentAnything) {
          controller.enqueue(
            encoder.encode("(The model returned an empty response.)")
          );
        }
        // Emit memory payload so the client can cache it for the next turn.
        if (memoryOut) {
          controller.enqueue(
            encoder.encode(`${MEMORY_MARKER}${JSON.stringify(memoryOut)}\n`)
          );
        }
        controller.close();
      } catch (err) {
        // If nothing has been sent yet we could still return JSON, but at
        // this point headers are committed; emit a readable error marker
        // the client detects, then close.
        try {
          if (err instanceof ModelUnavailableError) {
            // The chosen model vanished mid-stream. Drop the stale
            // availability cache and tell the client exactly which model
            // failed so it can disable it and refresh.
            invalidateModelsCache();
            controller.enqueue(
              encoder.encode(
                `${MODEL_UNAVAILABLE_MARKER}${err.model}\n${err.message}`
              )
            );
          } else {
            const safe =
              err instanceof AIProviderError
                ? err.message
                : "An unexpected error occurred while generating the response.";
            controller.enqueue(
              encoder.encode(`${STREAM_ERROR_MARKER}${safe}\n`)
            );
          }
          controller.close();
        } catch {
          /* stream already closed */
        }
      }
    },
    cancel() {
      /* client disconnected */
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
