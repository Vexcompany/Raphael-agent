import {
  AIProvider,
  ChatMessage,
  ParsedToolCall,
  ToolDefinition,
} from "@/lib/ai/types";
import { executeGitHubTool } from "@/lib/github/tools";

/**
 * Server-side agent loop: model <-> tools.
 *
 * Runs a conversation against an AI provider, feeding it the tool
 * definitions and executing any tool calls it makes, then returning the
 * (possibly multi-round) final answer. Text is streamed to the caller as it
 * arrives; tool executions are surfaced as compact events so the client can
 * show activity without leaking any payloads or secrets.
 */

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; ok: boolean };

export interface RunChatOptions {
  signal?: AbortSignal;
  /** Hard cap on tool rounds per request (default 8). */
  maxToolRounds?: number;
  /** Cap on total tool calls executed (default 24). */
  maxToolCalls?: number;
}

export async function* runChat(
  provider: AIProvider,
  messages: ChatMessage[],
  tools: readonly ToolDefinition[],
  opts?: RunChatOptions
): AsyncGenerator<AgentEvent, void, unknown> {
  const maxToolRounds = opts?.maxToolRounds ?? 8;
  const maxToolCalls = opts?.maxToolCalls ?? 24;
  const toolDefs = tools.length > 0 ? [...tools] : undefined;

  const conversation: ChatMessage[] = [...messages];
  let toolCallsExecuted = 0;

  for (let round = 0; ; round++) {
    if (round > maxToolRounds) {
      yield {
        type: "text",
        text: "\n\n_(Stopped after too many tool rounds. Please narrow the request.)_",
      };
      return;
    }

    let calls: ParsedToolCall[] | null = null;
    const textParts: string[] = [];

    for await (const chunk of provider.streamChat(conversation, {
      signal: opts?.signal,
      tools: toolDefs,
    })) {
      if (chunk.type === "text") {
        textParts.push(chunk.text);
        yield { type: "text", text: chunk.text };
      } else if (chunk.type === "tool_calls") {
        calls = chunk.calls;
      }
    }

    const finalText = textParts.join("");

    if (!calls || calls.length === 0) {
      // The model answered without tool calls — done.
      if (textParts.length === 0) {
        yield {
          type: "text",
          text: "(The model returned an empty response.)",
        };
      }
      return;
    }

    // Record the assistant turn (including its tool calls) so the provider
    // can continue the conversation coherently.
    conversation.push({
      role: "assistant",
      content: finalText,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.rawArguments },
      })),
    });

    for (const call of calls) {
      if (toolCallsExecuted >= maxToolCalls) break;
      const result = await executeGitHubTool(call);
      toolCallsExecuted += 1;
      yield { type: "tool", tool: call.name, ok: result.ok };

      conversation.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.output,
      });
    }

    // If every call was skipped by the cap, stop rather than loop forever.
    const executedThisRound = calls.length;
    if (toolCallsExecuted >= maxToolCalls && executedThisRound > 0) {
      yield {
        type: "text",
        text: "\n\n_(Stopped after too many tool calls. Please narrow the request.)_",
      };
      return;
    }
  }
}
