import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStream,
  TOOL_MARKER,
  STREAM_ERROR_MARKER,
  MODEL_UNAVAILABLE_MARKER,
  type MessageSegment,
} from "./events";

/** Build a tool marker exactly as the chat route emits one. */
function tool(name: string, ok = true): string {
  return `\n\n${TOOL_MARKER}${JSON.stringify({ name, ok })}\n`;
}

/** Reduce segments to a compact shape for easy ordering assertions. */
function shape(segments: MessageSegment[]): Array<string | { tool: string }> {
  return segments.map((s) => (s.type === "tool" ? { tool: s.tool } : `text:${s.text}`));
}

test("preserves text → tool → text order", () => {
  const raw =
    "Great! Let me start." +
    tool("inspect_repository") +
    "Now let me read the files.";
  const { segments, visible } = parseStream(raw);

  assert.deepEqual(shape(segments), [
    "text:Great! Let me start.",
    { tool: "inspect_repository" },
    "text:Now let me read the files.",
  ]);
  assert.equal(visible, "Great! Let me start.\n\nNow let me read the files.");
});

test("preserves multiple rounds: text → tool → text → tool → text", () => {
  const raw =
    "first" + tool("a") + "second" + tool("b", false) + "third";
  const { segments } = parseStream(raw);

  assert.deepEqual(
    segments.map((s) => s.type),
    ["text", "tool", "text", "tool", "text"]
  );
  const tools = segments.filter((s) => s.type === "tool");
  assert.deepEqual(
    tools.map((s) => (s as Extract<MessageSegment, { type: "tool" }>).tool),
    ["a", "b"]
  );
});

test("multiple tool calls keep their actual order", () => {
  const raw =
    "x" +
    tool("inspect_file_tree") +
    tool("read_file") +
    tool("read_file", false) +
    tool("read_file") +
    "y";
  const { segments } = parseStream(raw);

  const tools = segments.filter(
    (s): s is Extract<MessageSegment, { type: "tool" }> => s.type === "tool"
  );
  assert.deepEqual(
    tools.map((t) => t.tool),
    ["inspect_file_tree", "read_file", "read_file", "read_file"]
  );
  assert.deepEqual(
    tools.map((t) => t.ok),
    [true, true, false, true]
  );
  // Text on either side of the tool block is preserved.
  assert.equal(segments[0].type, "text");
  assert.equal(segments[segments.length - 1].type, "text");
});

test("text-only stream yields a single text segment", () => {
  const { segments, visible } = parseStream("hello world");
  assert.deepEqual(segments, [{ type: "text", text: "hello world" }]);
  assert.equal(visible, "hello world");
});

test("tool-only stream yields no visible text", () => {
  const { segments, visible } = parseStream(tool("inspect_repository"));
  assert.deepEqual(
    segments.map((s) => s.type),
    ["tool"]
  );
  assert.equal(visible, "");
});

test("empty stream yields nothing", () => {
  const { segments, visible, error, failedModel } = parseStream("");
  assert.deepEqual(segments, []);
  assert.equal(visible, "");
  assert.equal(error, null);
  assert.equal(failedModel, null);
});

test("a trailing, incomplete tool marker is held back and never rendered", () => {
  const partial = "started " + TOOL_MARKER + `{"name":"inspect_`;
  const { segments, visible } = parseStream(partial);

  // Only the complete text is visible; the partial marker is withheld.
  assert.deepEqual(shape(segments), ["text:started"]);
  assert.equal(visible, "started");

  // Once the marker completes, it appears at its position.
  const complete = "started " + tool("inspect_repository") + "after";
  const { segments: done } = parseStream(complete);
  assert.deepEqual(shape(done), [
    "text:started",
    { tool: "inspect_repository" },
    "text:after",
  ]);
});

test("malformed tool marker JSON degrades to an unknown tool", () => {
  const raw = `a\n\n${TOOL_MARKER}{not-json}\nb`;
  const { segments } = parseStream(raw);
  assert.deepEqual(shape(segments), [
    "text:a",
    { tool: "unknown" },
    "text:b",
  ]);
});

test("generic stream error truncates and surfaces the message", () => {
  const raw = "partial answer\n\n" + STREAM_ERROR_MARKER + "boom happened";
  const { segments, visible, error, failedModel } = parseStream(raw);

  assert.equal(error, "boom happened");
  assert.equal(failedModel, null);
  assert.equal(visible, "partial answer");
  // The error trailer is never part of the rendered text.
  assert.equal(
    segments
      .filter((s) => s.type === "text")
      .map((s) => (s as Extract<MessageSegment, { type: "text" }>).text)
      .join(""),
    "partial answer"
  );
});

test("model-unavailable marker surfaces the failed model id", () => {
  const raw =
    "partial\n\n" + MODEL_UNAVAILABLE_MARKER + "deepseek-v4-flash\nModel is gone";
  const { visible, error, failedModel } = parseStream(raw);

  assert.equal(failedModel, "deepseek-v4-flash");
  assert.equal(error, "Model is gone");
  assert.equal(visible, "partial");
});

test("re-parsing a growing buffer is stable across chunk boundaries", () => {
  // Simulate the client accumulating chunks: text, then a tool marker split
  // across two reads, then more text.
  const chunks = [
    "Great! Let me start",
    ` by inspecting.\n\n${TOOL_MARKER}{"name":"inspect_repository",`,
    `"ok":true}\nNow let me read.\n\n${TOOL_MARKER}`,
    `{"name":"read_file","ok":true}\nDone.`,
  ];

  let full = "";
  const lastToolList = (): string[] => {
    const { segments } = parseStream(full);
    return segments
      .filter((s): s is Extract<MessageSegment, { type: "tool" }> => s.type === "tool")
      .map((s) => s.tool);
  };

  // Before any chunk, nothing.
  assert.deepEqual(lastToolList(), []);

  full += chunks[0];
  assert.deepEqual(lastToolList(), []);

  // Mid-marker: the partial marker must not resolve (and not render as text).
  full += chunks[1];
  assert.deepEqual(lastToolList(), []);
  assert.equal(parseStream(full).visible, "Great! Let me start by inspecting.");

  // Marker completes: tool appears.
  full += chunks[2];
  assert.deepEqual(lastToolList(), ["inspect_repository"]);

  // Final chunk: second tool appears, and text order is intact.
  full += chunks[3];
  assert.deepEqual(lastToolList(), ["inspect_repository", "read_file"]);

  const final = parseStream(full);
  assert.deepEqual(
    final.segments.map((s) => s.type),
    ["text", "tool", "text", "tool", "text"]
  );
  assert.equal(
    final.visible,
    "Great! Let me start by inspecting.\n\nNow let me read.\n\nDone."
  );
});
