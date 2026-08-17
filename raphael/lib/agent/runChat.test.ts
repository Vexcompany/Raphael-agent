import { test } from "node:test";
import assert from "node:assert/strict";
import { runChat, type AgentEvent } from "@/lib/agent/runChat";
import type {
  AIProvider,
  AIStreamChunk,
  ChatMessage,
  ParsedToolCall,
  ToolDefinition,
} from "@/lib/ai/types";
import { parseStream, TOOL_MARKER } from "@/lib/stream/events";

/** A fake tool call whose name is unknown, so execution never touches GitHub. */
function call(id: string, name: string): ParsedToolCall {
  return { id, name, arguments: {}, rawArguments: "{}" };
}

/** A provider that replays one scripted turn per round of the agent loop. */
function scriptedProvider(script: AIStreamChunk[][]): AIProvider {
  let round = -1;
  return {
    name: "fake",
    async *streamChat() {
      round += 1;
      const turn = script[Math.min(round, script.length - 1)];
      for (const chunk of turn) {
        yield chunk;
      }
    },
  };
}

test("multi-tool task produces a chronological timeline end to end", async () => {
  const provider = scriptedProvider([
    [
      {
        type: "text",
        text: "Great! Let me start by inspecting the repository thoroughly.",
      },
      { type: "tool_calls", calls: [call("c1", "inspect_repository")] },
    ],
    [
      { type: "text", text: "Now let me read all the key files." },
      {
        type: "tool_calls",
        calls: [
          call("c2", "inspect_file_tree"),
          call("c3", "read_file"),
          call("c4", "read_file"),
          call("c5", "read_file"),
        ],
      },
    ],
    [{ type: "text", text: "Here is what I found." }],
  ]);

  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "inspect the repository" },
  ];
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: { name: "inspect_repository", description: "", parameters: {} },
    },
  ];

  const events: AgentEvent[] = [];
  for await (const e of runChat(provider, messages, tools)) {
    events.push(e);
  }

  // 1) The server-side agent loop already yields events chronologically.
  assert.deepEqual(
    events.map((e) => e.type),
    ["text", "tool", "text", "tool", "tool", "tool", "tool", "text"]
  );
  assert.deepEqual(
    events.filter((e) => e.type === "tool").map((e) => (e as { tool: string }).tool),
    ["inspect_repository", "inspect_file_tree", "read_file", "read_file", "read_file"]
  );

  // 2) Encode exactly as the chat route does (text verbatim, tools as markers).
  let stream = "";
  for (const e of events) {
    if (e.type === "text") {
      stream += e.text;
    } else {
      stream += `\n\n${TOOL_MARKER}${JSON.stringify({ name: e.tool, ok: e.ok })}\n`;
    }
  }

  // 3) The client parser reconstructs the same chronological timeline.
  const parsed = parseStream(stream);
  assert.deepEqual(
    parsed.segments.map((s) => s.type),
    ["text", "tool", "text", "tool", "tool", "tool", "tool", "text"]
  );
  assert.deepEqual(
    parsed.segments
      .filter((s): s is Extract<(typeof parsed.segments)[number], { type: "tool" }> => s.type === "tool")
      .map((s) => s.tool),
    ["inspect_repository", "inspect_file_tree", "read_file", "read_file", "read_file"]
  );
  assert.deepEqual(
    parsed.segments.filter((s) => s.type === "text").map((s) => s.text),
    [
      "Great! Let me start by inspecting the repository thoroughly.",
      "Now let me read all the key files.",
      "Here is what I found.",
    ]
  );
});
