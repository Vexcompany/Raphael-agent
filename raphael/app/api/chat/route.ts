import { getProvider } from "@/lib/ai/provider";
import { invalidateModelsCache, validateModel } from "@/lib/ai/models";
import { RAPHAEL_SYSTEM_PROMPT } from "@/lib/ai/systemPrompt";
import {
  AIProviderError,
  ChatMessage,
  ModelUnavailableError,
} from "@/lib/ai/types";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel function limit hint

const MAX_MESSAGES = 60; // most recent messages kept as context
const MAX_MESSAGE_CHARS = 32_000;
const MAX_BODY_BYTES = 1_000_000;

/** Emitted in the stream when the upstream model turns out to be unavailable. */
const MODEL_UNAVAILABLE_MARKER = "[RAPHAEL_MODEL_UNAVAILABLE]";
/** Emitted in the stream for generic safe errors after headers are committed. */
const STREAM_ERROR_MARKER = "[RAPHAEL_STREAM_ERROR]";

interface ParsedBody {
  messages: ChatMessage[];
  model?: string;
}

function badRequest(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
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
    // Clients may only send user/assistant turns; the system prompt is
    // controlled by the server.
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

  // Keep only the most recent context window.
  const trimmed = clean.slice(-MAX_MESSAGES);
  return { messages: trimmed, model };
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

  const messages: ChatMessage[] = [
    { role: "system", content: RAPHAEL_SYSTEM_PROMPT },
    ...parsed.messages,
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let sentAnything = false;
        for await (const chunk of provider.streamChat(messages, req.signal)) {
          sentAnything = true;
          controller.enqueue(encoder.encode(chunk));
        }
        if (!sentAnything) {
          controller.enqueue(
            encoder.encode("(The model returned an empty response.)")
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
                `\n\n${MODEL_UNAVAILABLE_MARKER}${err.model}\n${err.message}`
              )
            );
          } else {
            const safe =
              err instanceof AIProviderError
                ? err.message
                : "An unexpected error occurred while generating the response.";
            controller.enqueue(encoder.encode(`\n\n${STREAM_ERROR_MARKER}${safe}`));
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
