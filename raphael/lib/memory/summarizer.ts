import type { AIProvider, ChatMessage } from "@/lib/ai/types";
import type { SummarizeResult } from "./types";
import { RECENT_WINDOW, MIN_MESSAGES_FOR_SUMMARY } from "./types";

/**
 * Build a summarization prompt from the older messages that will be
 * compacted. The prompt asks the AI to produce a dense, factual summary
 * focused on information the assistant needs to continue helping.
 */
function buildSummarizePrompt(messages: ChatMessage[]): string {
  const transcript = messages
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      // Truncate very long messages to keep the summarization cheap.
      const content =
        m.content.length > 1200
          ? m.content.slice(0, 1200) + "…[truncated]"
          : m.content;
      return `[${role}]: ${content}`;
    })
    .join("\n\n");

  return `Summarize the following conversation between a user and an AI assistant (Axiom AI RV).

Focus on:
- What the user asked for (tasks, preferences, decisions).
- What the assistant did or recommended (actions taken, files changed, PRs opened).
- Any unresolved or pending items.
- Key facts the assistant should remember (repo names, branch names, file paths).

Be concise. Use plain English. Do NOT include pleasantries or meta-commentary.
Do NOT use markdown headings — just a compact paragraph or bullet list with dashes.

Conversation:

${transcript}

Summary:`;
}

/**
 * Summarize older messages into a compact memory context.
 *
 * The caller provides the full message array (excluding system messages).
 * We split off the most recent RECENT_WINDOW messages (kept verbatim) and
 * summarize the rest.
 *
 * Returns null when summarization is not needed (too few messages).
 */
export async function summarizeConversation(
  provider: AIProvider,
  messages: ChatMessage[]
): Promise<SummarizeResult | null> {
  if (messages.length < MIN_MESSAGES_FOR_SUMMARY) return null;

  const splitAt = Math.max(0, messages.length - RECENT_WINDOW);
  if (splitAt === 0) return null;

  const oldMessages = messages.slice(0, splitAt);

  const prompt = buildSummarizePrompt(oldMessages);

  // Call the provider with a single-turn summarization request.
  // We use a simple user message — no tools, no streaming needed.
  const summaryMessages: ChatMessage[] = [
    {
      role: "user",
      content: prompt,
    },
  ];

  let summary = "";
  try {
    for await (const chunk of provider.streamChat(summaryMessages, {
      maxTokens: 600,
    })) {
      if (chunk.type === "text") {
        summary += chunk.text;
      }
    }
  } catch {
    // Summarization is best-effort. If it fails, return null so the
    // caller falls back to sending all messages (trimmed by the existing
    // MAX_MESSAGES cap).
    return null;
  }

  const cleaned = summary.trim();
  if (!cleaned) return null;

  return {
    summary: cleaned,
    summarizedUntil: splitAt,
    messageCount: messages.length,
  };
}

/**
 * Decide whether an existing client-side summary is still fresh, or
 * whether we need to regenerate it.
 *
 * A summary is stale when:
 * - The conversation has grown significantly since it was made.
 * - The summarizedUntil index no longer aligns with the current window.
 */
export function isSummaryFresh(
  currentMessageCount: number,
  summarizedUntil: number,
  summarizedMessageCount: number
): boolean {
  // If the conversation doubled in size, re-summarize.
  if (currentMessageCount > summarizedMessageCount * 1.5) return false;
  // If the recent window has shifted past the summarized range, re-summarize.
  const expectedSplit = Math.max(0, currentMessageCount - RECENT_WINDOW);
  if (summarizedUntil < expectedSplit - 2) return false;
  return true;
}
