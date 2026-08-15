import { getProvider } from "@/lib/ai/provider";
import { RAPHAEL_SYSTEM_PROMPT } from "@/lib/ai/systemPrompt";
import { AIProviderError, ChatMessage } from "@/lib/ai/types";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel function limit hint

const MAX_MESSAGES = 60; // most recent messages kept as context
const MAX_MESSAGE_CHARS = 32_000;
const MAX_BODY_BYTES = 1_000_000;

interface ParsedBody {
  messages: ChatMessage[];
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

  // Keep only the most recent context window.
  const trimmed = clean.slice(-MAX_MESSAGES);
  return { messages: trimmed };
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

  let provider;
  try {
    provider = getProvider();
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
        const safe =
          err instanceof AIProviderError
            ? err.message
            : "An unexpected error occurred while generating the response.";
        try {
          controller.enqueue(encoder.encode(`\n\n[RAPHAEL_STREAM_ERROR]${safe}`));
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
