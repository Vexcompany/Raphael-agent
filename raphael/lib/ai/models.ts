import { AIProviderError } from "./types";

/**
 * Ryzumi model registry + availability.
 *
 * Two layers:
 *
 * 1. A static FALLBACK registry of every model id Raphael knows about, with
 *    availability captured from a snapshot of the Ryzumi "Active Models"
 *    page on 2026-08-16. This snapshot is ONLY a fallback — it is NOT
 *    treated as permanent truth.
 *
 * 2. An authenticated server-side GET to the Ryzumi OpenAI-compatible
 *    `/models` endpoint. If that endpoint works and exposes stock/status
 *    metadata it becomes the source of truth. If it does not (or is not
 *    supported), we keep the static registry and structure the code so
 *    realtime availability can be connected later.
 *
 * Everything here runs on the server only. No credentials ever leave it.
 */

export type ModelAvailability = "active" | "out_of_stock";

export interface ModelInfo {
  /** Exact model id sent to the Ryzumi API, never renamed. */
  id: string;
  /** Human-readable name shown in the UI. */
  displayName: string;
  availability: ModelAvailability;
  /** Logical UI group (Auto, Claude, GPT, DeepSeek, …). */
  group: string;
  /** Optional metadata from the Ryzumi model directory when available. */
  grade?: string;
  modality?: string;
}

export interface ModelsResult {
  models: ModelInfo[];
  /** "ryzumi" when the live /models endpoint answered, else "fallback". */
  source: "ryzumi" | "fallback";
  refreshedAt: number;
}

const MODEL_CACHE_TTL_MS = 30_000;
const MODELS_REQUEST_TIMEOUT_MS = 8_000;

/* ------------------------------------------------------------------ */
/* Static fallback registry (snapshot, not permanent truth).           */
/* ------------------------------------------------------------------ */

type FallbackAvailability = ModelAvailability;

const FALLBACK_ENTRIES: Array<{
  id: string;
  availability: FallbackAvailability;
}> = [
  { id: "auto", availability: "active" },
  { id: "auto-debug", availability: "out_of_stock" },
  { id: "claude-opus-4.8", availability: "out_of_stock" },
  { id: "claude-opus-4.8-b", availability: "out_of_stock" },
  { id: "claude-opus-5", availability: "out_of_stock" },
  { id: "claude-opus-5-b", availability: "active" },
  { id: "claude-sonnet-4.5", availability: "out_of_stock" },
  { id: "claude-sonnet-4.5-thinking", availability: "out_of_stock" },
  { id: "claude-sonnet-4.6-b", availability: "out_of_stock" },
  { id: "claude-sonnet-5", availability: "out_of_stock" },
  { id: "claude-sonnet-5-b", availability: "out_of_stock" },
  { id: "deepseek-v4-flash", availability: "active" },
  { id: "deepseek-v4-mod", availability: "active" },
  { id: "deepseek-v4-pro", availability: "active" },
  { id: "deepseek-v4-pro-0813", availability: "active" },
  { id: "deepseek-v4-pro-b", availability: "out_of_stock" },
  { id: "glm-5.2", availability: "active" },
  { id: "glm-5.3", availability: "active" },
  { id: "gpt-5.5", availability: "out_of_stock" },
  { id: "gpt-5.6", availability: "active" },
  { id: "gpt-5.6-luna", availability: "active" },
  { id: "gpt-5.6-luna-b", availability: "out_of_stock" },
  { id: "gpt-5.6-sol", availability: "out_of_stock" },
  { id: "gpt-5.6-sol-b", availability: "out_of_stock" },
  { id: "gpt-5.6-sol-xhigh", availability: "out_of_stock" },
  { id: "gpt-5.6-terra", availability: "active" },
  { id: "gpt-5.6-terra-b", availability: "out_of_stock" },
  { id: "grok-4.3-b", availability: "out_of_stock" },
  { id: "hy3", availability: "active" },
  { id: "kimi-k2.7-code", availability: "active" },
  { id: "kimi-k2.7-code-highspeed", availability: "active" },
  { id: "kimi-k3", availability: "active" },
  { id: "mimo-v2.5-pro", availability: "out_of_stock" },
  { id: "mistral-large-3-675b-instruct", availability: "out_of_stock" },
  { id: "qwen3.7-max", availability: "out_of_stock" },
  { id: "qwen3.8-max", availability: "out_of_stock" },
];

const VENDOR_NAMES: Record<string, string> = {
  auto: "Auto",
  claude: "Claude",
  gpt: "GPT",
  deepseek: "DeepSeek",
  glm: "GLM",
  grok: "Grok",
  kimi: "Kimi",
  qwen: "Qwen",
  mistral: "Mistral",
  mimo: "Mimo",
  hy3: "Hy3",
};

const GROUP_NAMES = [
  "Auto",
  "Claude",
  "GPT",
  "DeepSeek",
  "Qwen",
  "Kimi",
  "GLM",
  "Grok",
  "Mistral",
  "Other",
] as const;

export const MODEL_GROUPS: readonly string[] = GROUP_NAMES;

/** Human-readable display name derived from a Ryzumi model id. */
export function humanize(id: string): string {
  if (id === "auto") return "Auto";
  const parts = id.split("-");
  const first = parts[0].toLowerCase();
  parts[0] = VENDOR_NAMES[first] ?? parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (/^[0-9]+(\.[0-9]+)?$/.test(p)) continue; // numbers: 5.6, 0813, 3
    if (/^v[0-9]+$/.test(p)) {
      parts[i] = p.toUpperCase(); // v4 -> V4
      continue;
    }
    if (/^[0-9]+[a-z]$/.test(p)) {
      parts[i] = p.slice(0, -1) + p.slice(-1).toUpperCase(); // 675b -> 675B
      continue;
    }
    parts[i] = p.charAt(0).toUpperCase() + p.slice(1);
  }
  return parts.join(" ");
}

/** Logical group for a model id. */
export function groupFor(id: string): string {
  if (id === "auto" || id === "auto-debug") return "Auto";
  const prefix = id.split("-")[0].toLowerCase();
  const known = VENDOR_NAMES[prefix];
  if (known && known !== "Auto") return known;
  return "Other";
}

/** Build the static fallback list with display names + groups filled in. */
function buildFallback(): ModelInfo[] {
  return FALLBACK_ENTRIES.map((e) => ({
    id: e.id,
    displayName: humanize(e.id),
    availability: e.availability,
    group: groupFor(e.id),
  }));
}

/* ------------------------------------------------------------------ */
/* Live /models fetch + merge + cache.                                 */
/* ------------------------------------------------------------------ */

function mapAvailability(raw: unknown): ModelAvailability | null {
  if (typeof raw === "string") {
    const s = raw.toLowerCase();
    if (/^(active|available|in[-_ ]?stock|ready|enabled|yes|true|1)$/.test(s)) return "active";
    if (/^(out[-_ ]of[-_ ]stock|out_of_stock|unavailable|sold[-_ ]?out|disabled|maintenance|no|false|0)$/.test(s))
      return "out_of_stock";
    return null;
  }
  if (typeof raw === "boolean") return raw ? "active" : "out_of_stock";
  if (typeof raw === "number") return raw > 0 ? "active" : "out_of_stock";
  return null;
}

/** Pull stock/status metadata out of a /models entry, if present. */
function extractAvailability(item: Record<string, unknown>): ModelAvailability | null {
  for (const key of ["availability", "status", "stock", "in_stock", "available"]) {
    const mapped = mapAvailability(item[key]);
    if (mapped) return mapped;
  }
  return null;
}

/**
 * Authenticated GET to the Ryzumi OpenAI-compatible /models endpoint.
 * Returns null when the endpoint is not supported / unreachable / malformed.
 * The upstream response is never exposed to the client.
 */
async function fetchRyzumiModels(): Promise<{ models: ModelInfo[]; hasRealtimeStatus: boolean } | null> {
  const apiKey = process.env.RYZUMI_API_KEY;
  const baseUrl = process.env.RYZUMI_BASE_URL;
  if (!apiKey || !baseUrl) return null;

  const timeout = AbortSignal.timeout(MODELS_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: timeout,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;

  const fallbackById = new Map(buildFallback().map((m) => [m.id, m]));
  const models: ModelInfo[] = [];
  let hasRealtimeStatus = false;

  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;

    const explicit = extractAvailability(item);
    if (explicit) hasRealtimeStatus = true;
    const fb = fallbackById.get(id);

    models.push({
      id,
      displayName: fb?.displayName ?? humanize(id),
      // Prefer live stock metadata; keep the snapshot status for known
      // models when the API exposes no realtime status.
      availability: explicit ?? fb?.availability ?? "active",
      group: fb?.group ?? groupFor(id),
      grade: typeof item.grade === "string" ? item.grade : undefined,
      modality: typeof item.modality === "string" ? item.modality : undefined,
    });
  }

  if (models.length === 0) return null;
  return { models, hasRealtimeStatus };
}

/** Union of the fallback registry and the live catalog. */
function mergeModels(live: { models: ModelInfo[]; hasRealtimeStatus: boolean }): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const m of buildFallback()) byId.set(m.id, m);

  // Live entries already carry snapshot status for known models when the
  // API exposes no realtime metadata, so a plain overlay is safe either way.
  for (const m of live.models) byId.set(m.id, m);

  return [...byId.values()];
}

let cache: { result: ModelsResult; at: number } | null = null;

/**
 * Server-side model list with availability.
 * Cached for MODEL_CACHE_TTL_MS; pass { refresh: true } to force a re-fetch.
 */
export async function getModels(opts?: { refresh?: boolean }): Promise<ModelsResult> {
  const now = Date.now();
  if (!opts?.refresh && cache && now - cache.at < MODEL_CACHE_TTL_MS) {
    return cache.result;
  }

  const live = await fetchRyzumiModels();
  const result: ModelsResult = live
    ? { models: mergeModels(live), source: "ryzumi", refreshedAt: now }
    : { models: buildFallback(), source: "fallback", refreshedAt: now };

  cache = { result, at: now };
  return result;
}

/** Drop the cache so the next getModels() call hits the API again. */
export function invalidateModelsCache(): void {
  cache = null;
}

export function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}

export function isModelAvailable(model: ModelInfo | undefined): boolean {
  return !!model && model.availability === "active";
}

/**
 * Validate a client-supplied model id against the latest registry.
 * Throws an AIProviderError with a safe, user-presentable message when the
 * model is unknown or currently out of stock — arbitrary model ids must
 * never reach the upstream chat-completions call.
 */
export async function validateModel(id: string): Promise<void> {
  const { models } = await getModels();
  const model = findModel(models, id);
  if (!model) {
    throw new AIProviderError(`Unknown model "${id}".`, 400);
  }
  if (model.availability === "out_of_stock") {
    throw new AIProviderError(`The model "${model.displayName}" is currently out of stock.`, 409);
  }
}
