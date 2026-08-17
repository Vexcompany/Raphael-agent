/**
 * Memory / context types for the conversation summarization system.
 *
 * Instead of sending every message to the AI on every request (which
 * inflates token usage linearly), we keep a sliding window of recent
 * messages and summarize older ones into a compact "memory context"
 * that is injected into the system prompt.
 */

/** Payload the client sends alongside messages to carry cached memory. */
export interface MemoryPayload {
  /** Compact summary of older conversation turns. */
  summary: string;
  /**
   * The index (in the client's full message array) of the *first* message
   * that was summarized. The server uses this to decide whether the
   * summary is still fresh or needs to be regenerated.
   */
  summarizedUntil: number;
  /** Total message count when the summary was produced. */
  messageCount: number;
}

/** Result of a summarization pass — returned to the client for caching. */
export interface SummarizeResult {
  summary: string;
  summarizedUntil: number;
  messageCount: number;
}

/**
 * Number of most-recent messages kept in full (not summarized).
 * Must be even so user/assistant pairs stay balanced.
 */
export const RECENT_WINDOW = 8;

/**
 * Minimum number of messages before we bother summarizing.
 * Below this threshold the token savings are negligible.
 */
export const MIN_MESSAGES_FOR_SUMMARY = 12;
