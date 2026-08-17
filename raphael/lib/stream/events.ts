/**
 * Shared streaming-event parsing for the Raphael agent.
 *
 * The chat route interleaves plain text and compact `[RAPHAEL_TOOL]`
 * activity markers in a single byte stream, in the exact chronological order
 * the agent produced them (assistant text, then tool executions, then more
 * assistant text, and so on). This module turns that raw accumulated text
 * back into an ordered list of segments so the UI can render assistant text,
 * tool calls, and the text that follows them in their true order — instead
 * of collecting every tool call and prepending it to the message.
 *
 * The marker strings must match the ones emitted by `app/api/chat/route.ts`;
 * they are re-exported here so both the server route and the client parser
 * share a single source of truth.
 *
 * This module is deliberately dependency-free (no React/Next/server imports)
 * so it can be unit-tested in isolation.
 */

export type MessageSegment =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; ok: boolean };

/** Emitted before each tool execution so the client can show activity. */
export const TOOL_MARKER = "[RAPHAEL_TOOL]";
/** Emitted in the stream for generic safe errors after headers are committed. */
export const STREAM_ERROR_MARKER = "[RAPHAEL_STREAM_ERROR]";
/** Emitted in the stream when the upstream model turns out to be unavailable. */
export const MODEL_UNAVAILABLE_MARKER = "[RAPHAEL_MODEL_UNAVAILABLE]";

export interface ParsedStream {
  /** Ordered text/tool segments exactly as they occurred in the stream. */
  segments: MessageSegment[];
  /** Concatenated visible text (tool markers and error trailers removed). */
  visible: string;
  /** Error message surfaced mid-stream, if any. */
  error: string | null;
  /** Model id that failed mid-stream, if any. */
  failedModel: string | null;
}

/**
 * Find the exclusive end index of a complete tool marker beginning at
 * `start`, or -1 when the marker has not fully arrived yet (e.g. it was
 * split across a chunk boundary).
 */
function findToolMarkerEnd(s: string, start: number): number {
  const open = s.indexOf("{", start + TOOL_MARKER.length);
  if (open === -1) return -1;
  const close = s.indexOf("}", open);
  if (close === -1) return -1;
  const nl = s.indexOf("\n", close);
  if (nl === -1) return -1;
  return nl + 1;
}

function parseToolMarker(s: string, start: number, end: number): MessageSegment {
  const open = s.indexOf("{", start);
  const close = s.lastIndexOf("}", end - 1);
  let tool = "unknown";
  let ok = false;
  if (open !== -1 && close > open) {
    try {
      const parsed = JSON.parse(s.slice(open, close + 1)) as {
        name?: unknown;
        ok?: unknown;
      };
      tool = typeof parsed.name === "string" && parsed.name ? parsed.name : "unknown";
      ok = parsed.ok === true;
    } catch {
      /* malformed marker body — keep the safe defaults */
    }
  }
  return { type: "tool", tool, ok };
}

/**
 * Append a text run, dropping the marker framing whitespace (the route emits
 * `\n\n` before every tool/error marker purely as a separator) and skipping
 * whitespace-only runs so no empty markdown blocks are rendered.
 */
function pushText(segments: MessageSegment[], text: string): void {
  const trimmed = text.trimEnd();
  if (trimmed) {
    segments.push({ type: "text", text: trimmed });
  }
}

/** Split a tool-marker-free string into ordered text/tool segments. */
function tokenize(raw: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let pos = 0;

  while (pos < raw.length) {
    const mStart = raw.indexOf(TOOL_MARKER, pos);
    if (mStart === -1) break;
    const mEnd = findToolMarkerEnd(raw, mStart);
    if (mEnd === -1) break; // incomplete trailing marker — held back
    if (mStart > pos) {
      pushText(segments, raw.slice(pos, mStart));
    }
    segments.push(parseToolMarker(raw, mStart, mEnd));
    pos = mEnd;
  }

  // Whatever remains is text, unless it starts with a not-yet-complete
  // marker (which must be withheld so it never renders as literal text).
  let tail = raw.slice(pos);
  const pendingIdx = tail.indexOf(TOOL_MARKER);
  if (pendingIdx !== -1) {
    tail = tail.slice(0, pendingIdx);
  }
  pushText(segments, tail);

  return segments;
}

/**
 * Split the accumulated raw stream into ordered segments plus any trailing
 * error state. Re-running this on the growing buffer on every chunk is
 * idempotent and cheap: the stream is bounded and markers are tiny.
 */
export function parseStream(raw: string): ParsedStream {
  let error: string | null = null;
  let failedModel: string | null = null;

  // Error trailers terminate the stream, so cut there first. Prefer the
  // earliest of the two markers (they cannot overlap).
  const mIdx = raw.indexOf(MODEL_UNAVAILABLE_MARKER);
  const sIdx = raw.indexOf(STREAM_ERROR_MARKER);
  let cutAt = -1;
  let modelUnavailable = false;
  if (mIdx !== -1 && (sIdx === -1 || mIdx < sIdx)) {
    cutAt = mIdx;
    modelUnavailable = true;
  } else if (sIdx !== -1) {
    cutAt = sIdx;
  }

  let body = raw;
  if (cutAt !== -1) {
    const marker = modelUnavailable ? MODEL_UNAVAILABLE_MARKER : STREAM_ERROR_MARKER;
    const after = raw.slice(cutAt + marker.length);
    if (modelUnavailable) {
      const nl = after.indexOf("\n");
      failedModel = (nl === -1 ? after : after.slice(0, nl)).trim();
      error = (
        nl === -1
          ? "The selected model is currently unavailable."
          : after.slice(nl + 1)
      ).trim();
    } else {
      error = after.trim();
    }
    body = raw.slice(0, cutAt);
  }

  const segments = tokenize(body);
  const visible = segments
    .filter((s): s is Extract<MessageSegment, { type: "text" }> => s.type === "text")
    .map((s) => s.text)
    .join("\n\n");

  return { segments, visible, error, failedModel };
}
