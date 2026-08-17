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
 *
 * Error truthfulness: a provider that yields no chunks at all produces the
 * distinct "(The model returned an empty response.)" note; a provider that
 * times out or fails mid-stream throws and is *not* converted into that
 * message, so the caller can surface a truthful error while the partial
 * text already streamed is preserved.
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

/** Cap on a single tool result fed back to the model (protects later rounds). */
const MAX_TOOL_OUTPUT_CHARS = 60_000;
/** Cap on the in-flight conversation window (keeps tool rounds bounded). */
const MAX_CONVERSATION_MESSAGES = 80;

function capToolOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT_CHARS) return s;
  const omitted = s.length - MAX_TOOL_OUTPUT_CHARS;
  return `${s.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[Result truncated: ${omitted} characters omitted.]`;
}

/**
 * Drop the oldest messages so the tail of the conversation fits in a bounded
 * window. Never cuts a tool round in half: a trailing "tool" message requires
 * the assistant `tool_calls` message that precedes it, so the cut is backed
 * up until it lands on a non-tool message.
 */
function trimConversation(conversation: ChatMessage[]): void {
  if (conversation.length <= MAX_CONVERSATION_MESSAGES) return;
  let start = conversation.length - MAX_CONVERSATION_MESSAGES;
  while (start > 1 && conversation[start]?.role === "tool") start -= 1;
  const kept = [conversation[0], ...conversation.slice(start)];
  conversation.splice(0, conversation.length, ...kept);
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
    if (round > 0) trimConversation(conversation);

    let calls: ParsedToolCall[] | null = null;
    const textParts: string[] = [];
    // True once the model produced any delta (text, reasoning, or tool calls)
    // so an actual (possibly reasoning-only) response is never reported as
    // "empty".
    let responded = false;

    for await (const chunk of provider.streamChat(conversation, {
      signal: opts?.signal,
      tools: toolDefs,
    })) {
      if (chunk.type === "text") {
        responded = true;
        textParts.push(chunk.text);
        yield { type: "text", text: chunk.text };
      } else if (chunk.type === "reasoning") {
        responded = true;
      } else if (chunk.type === "tool_calls") {
        responded = true;
        calls = chunk.calls;
      }
    }

    const finalText = textParts.join("");

    if (!calls || calls.length === 0) {
      // The model answered without tool calls — done.
      if (textParts.length === 0 && !responded) {
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

    let executedThisRound = 0;
    for (const call of calls) {
      if (toolCallsExecuted >= maxToolCalls) break;
      const result = await executeGitHubTool(call);
      toolCallsExecuted += 1;
      executedThisRound += 1;
      yield { type: "tool", tool: call.name, ok: result.ok };

      conversation.push({
        role: "tool",
        tool_call_id: call.id,
        content: capToolOutput(result.output),
      });
    }

    // If the cap stopped us from making further progress, stop rather than
    // loop forever.
    if (executedThisRound === 0 || toolCallsExecuted >= maxToolCalls) {
      yield {
        type: "text",
        text: "\n\n_(Stopped after too many tool calls. Please narrow the request.)_",
      };
      return;
    }
  }
}
