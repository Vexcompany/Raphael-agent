import { ChatMessage } from "@/lib/ai/types";

/**
 * Decide whether a request plausibly needs the GitHub tools, and therefore
 * whether the full tool schema should be attached to the provider call.
 *
 * Sending all 13 GitHub tool schemas on every request costs a measurable
 * slice of the prompt budget (~1,600 tokens) before any output is produced.
 * To keep ordinary chat cheap we only attach tools when the conversation
 * plausibly wants repository work; any request that actually does contains
 * at least one strong keyword below, so real agent tasks keep full access.
 */

const STRONG_INDICATORS: RegExp[] = [
  /\bgithub\b/i,
  /\brepos?tories?\b/i,
  /\brepo\b/i,
  /\bgit\b/i,
  /\bpull request\b/i,
  /\bpr\s*#?\d*\b/i,
  /\bissue\b/i,
  /\bcommit\b/i,
  /\bbranch\b/i,
  /\bmerge\b/i,
  /\bpush\b/i,
  /\bclone\b/i,
  /\bfork\b/i,
  /\bworkflow\b/i,
  /\bactions?\b/i,
  /\bruns?\b/i, // GitHub Actions runs
  /\bchecks?\b/i, // CI checks
  /\bci\b/i,
  /\bfile\b/i,
  /\bfiles\b/i,
  /\bfolder\b/i,
  /\bdirectory\b/i,
  /\btree\b/i,
  /\binspect\b/i,
  /\bread\b/i,
  /\bcode\b/i,
  /\breadme\b/i,
  /\blicense\b/i,
  /\bchangelog\b/i,
  /\brefactor\b/i,
  /\bimplement\b/i,
  /\bopen source\b/i,
  /\bstar\b/i,
  /[\w.-]+\/[\w.-]+/, // owner/repo pattern
  /\b\.(ts|tsx|js|jsx|py|go|rs|md|json|yml|yaml|sh|css|html)\b/i,
];

/**
 * @returns true when the conversation contains a strong GitHub/repo signal;
 * plain chat (greetings, thanks, general questions with no repo keywords)
 * returns false so the provider call stays cheap.
 */
export function likelyNeedsGitHub(messages: readonly ChatMessage[]): boolean {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.content;
    if (STRONG_INDICATORS.some((re) => re.test(text))) return true;
  }
  return false;
}
