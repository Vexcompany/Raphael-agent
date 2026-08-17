/**
 * Stream event markers and parser shared by the chat route and the client.
 *
 * The server emits a plain-text stream where tool executions and errors are
 * embedded as compact JSON lines behind a marker prefix. The client parses
 * the stream to extract visible markdown, ordered tool-activity segments,
 * and error messages.
 *
 * All markers are chosen so they never appear in normal AI-generated
 * Markdown output.
 */

// ── Markers ────────────────────────────────────────────────────────────────

/** Prefix for a compact tool-execution event line. */
export const TOOL_MARKER = "\n\n%%%TOOL:";

/** Prefix for a stream-level error event line. */
export const STREAM_ERROR_MARKER = "\n\n%%%ERR:";

/**
 * Prefix for a model-unavailable event line. The model id follows the
 * marker, then a newline, then the human-readable message.
 */
export const MODEL_UNAVAILABLE_MARKER = "\n\n%%%MODEL_DOWN:";

/**
 * Prefix for a memory/summary event line. The client caches this summary
 * and sends it back on the next request so the server doesn't need to
 * re-summarize on every turn.
 */
export const MEMORY_MARKER = "\n\n%%%MEMORY:";

// ── Segment types ──────────────────────────────────────────────────────────

export type MessageSegment =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; ok: boolean };

/** Cached conversation memory returned by the server for the next request. */
export interface StreamMemoryPayload {
  summary: string;
  summarizedUntil: number;
  messageCount: number;
}

export interface ParsedStream {
  /** Visible text only (tool markers and errors stripped). */
  visible: string;
  /** Ordered text/tool segments for timeline rendering. */
  segments: MessageSegment[];
  /**
   * If the stream ended with an error marker, this is the human-readable
   * error message. Null otherwise.
   */
  error: string | null;
  /**
   * If the stream carried a model-unavailable marker, this is the model id
   * that failed. Null otherwise.
   */
  failedModel: string | null;
  /**
   * If the stream carried a memory marker, this is the summary payload
   * the client should cache for the next request.
   */
  memory: StreamMemoryPayload | null;
}

// ── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse a partially-accumulated stream into visible text, ordered
 * text/tool segments, and any error or model-unavailable markers.
 *
 * Safe to call on every chunk — it re-parses the entire accumulated
 * string each time, which is cheap for typical conversation lengths.
 */
export function parseStream(raw: string): ParsedStream {
  const segments: MessageSegment[] = [];
  let error: string | null = null;
  let failedModel: string | null = null;
  let memory: StreamMemoryPayload | null = null;

  // Split on known markers while preserving the order.
  const MARKER_RE = /\n\n%%%(TOOL|ERR|MODEL_DOWN|MEMORY):/g;

  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = MARKER_RE.exec(raw)) !== null) {
    // Text before this marker.
    const before = raw.slice(lastIdx, match.index);
    if (before) {
      segments.push({ type: "text", text: before });
    }

    const markerType = match[1];
    const payloadStart = match.index + match[0].length;

    if (markerType === "TOOL") {
      // Payload: JSON { name, ok } followed by a newline.
      const nl = raw.indexOf("\n", payloadStart);
      const payload = nl > -1 ? raw.slice(payloadStart, nl) : raw.slice(payloadStart);
      try {
        const parsed: unknown = JSON.parse(payload);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { name?: unknown }).name === "string" &&
          typeof (parsed as { ok?: unknown }).ok === "boolean"
        ) {
          const p = parsed as { name: string; ok: boolean };
          segments.push({ type: "tool", tool: p.name, ok: p.ok });
        }
      } catch {
        // Malformed tool marker — ignore.
      }
      lastIdx = nl > -1 ? nl + 1 : payloadStart;
    } else if (markerType === "ERR") {
      const nl = raw.indexOf("\n", payloadStart);
      error = nl > -1 ? raw.slice(payloadStart, nl) : raw.slice(payloadStart);
      lastIdx = nl > -1 ? nl + 1 : raw.length;
    } else if (markerType === "MODEL_DOWN") {
      const nl = raw.indexOf("\n", payloadStart);
      failedModel = nl > -1 ? raw.slice(payloadStart, nl) : raw.slice(payloadStart);
      // Optional human message on the next line (kept in error path by the route).
      if (nl > -1) {
        const after = raw.slice(nl + 1);
        const nextMarker = after.search(/\n\n%%%/);
        const msg = nextMarker === -1 ? after : after.slice(0, nextMarker);
        if (msg.trim() && !error) {
          error = msg.trim();
        }
        lastIdx = nl + 1 + (nextMarker === -1 ? after.length : nextMarker);
      } else {
        lastIdx = raw.length;
      }
    } else if (markerType === "MEMORY") {
      // Payload: JSON object { summary, summarizedUntil, messageCount } or a bare string.
      const nl = raw.indexOf("\n", payloadStart);
      const payload = nl > -1 ? raw.slice(payloadStart, nl) : raw.slice(payloadStart);
      try {
        const parsed: unknown = JSON.parse(payload);
        if (typeof parsed === "string" && parsed.length > 0) {
          memory = { summary: parsed, summarizedUntil: 0, messageCount: 0 };
        } else if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { summary?: unknown }).summary === "string" &&
          (parsed as { summary: string }).summary.length > 0
        ) {
          const p = parsed as {
            summary: string;
            summarizedUntil?: unknown;
            messageCount?: unknown;
          };
          memory = {
            summary: p.summary,
            summarizedUntil:
              typeof p.summarizedUntil === "number" ? p.summarizedUntil : 0,
            messageCount: typeof p.messageCount === "number" ? p.messageCount : 0,
          };
        }
      } catch {
        // Malformed memory marker — ignore.
      }
      lastIdx = nl > -1 ? nl + 1 : raw.length;
    }
  }

  // Remaining text after the last marker.
  const after = raw.slice(lastIdx);
  if (after) {
    segments.push({ type: "text", text: after });
  }

  // Build visible text from segments (tool segments are invisible).
  const visible = segments
    .filter((s) => s.type === "text")
    .map((s) => (s as { type: "text"; text: string }).text)
    .join("");

  return { visible, segments, error, failedModel, memory };
}
