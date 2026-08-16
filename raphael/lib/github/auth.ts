import crypto from "node:crypto";

/**
 * GitHub App authentication (server-side only).
 *
 * Uses the GitHub App credentials from the environment to mint a short-lived
 * app JWT, resolve the installation for a repo, and exchange it for an
 * installation access token. Tokens are cached until near expiry so the
 * agent does not hammer the GitHub API.
 *
 * Required env vars (never exposed to the client):
 *   GITHUB_APP_ID         - GitHub App id (string)
 *   GITHUB_PRIVATE_KEY    - PEM private key (newlines may be \n-escaped)
 * Optional:
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET - OAuth creds (unused server-side)
 *   GITHUB_BOT_NAME / GITHUB_BOT_EMAIL      - author identity for commits
 *
 * GitHub App auth is used instead of a personal access token so that every
 * action is scoped to the installation and revocable per app.
 */

/** GitHub REST base URL (override for tests/local proxies). */
export function getGitHubApiBase(): string {
  return (process.env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/+$/, "");
}

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const REQUEST_TIMEOUT_MS = 20_000;
const JWT_MAX_TTL_S = 10 * 60;
const JWT_REFRESH_BEFORE_S = 60;
const TOKEN_REFRESH_BEFORE_MS = 60_000;
const INSTALLATION_CACHE_TTL_MS = 5 * 60_000;

/** Safe, user-presentable GitHub error (status hints how to react). */
export class GitHubError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export interface GitHubConfig {
  appId: string;
  privateKey: string;
}

export function getGitHubConfig(): GitHubConfig | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  return { appId, privateKey };
}

export function isGitHubConfigured(): boolean {
  return getGitHubConfig() !== null;
}

/** Bot identity used for commits authored by the agent. */
export function getGitHubBotIdentity(): { name: string; email: string } {
  return {
    name: process.env.GITHUB_BOT_NAME || "axiom-ai-rv[bot]",
    email:
      process.env.GITHUB_BOT_EMAIL ||
      "axiom-ai-rv[bot]@users.noreply.github.com",
  };
}

/* ------------------------------------------------------------------ */
/* App JWT (RS256, no external dependency).                            */
/* ------------------------------------------------------------------ */

/** Vercel-style envs often store newlines as literal "\n". */
function normalizePrivateKey(raw: string): string {
  const unescaped = raw.replace(/\\n/g, "\n");
  if (unescaped.includes("-----BEGIN")) return unescaped;
  try {
    const decoded = Buffer.from(unescaped.trim(), "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) return decoded;
  } catch {
    /* not base64 — use as-is */
  }
  return unescaped;
}

function signJwt(payload: Record<string, unknown>, pem: string): string {
  const header = { alg: "RS256", typ: "JWT" };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = crypto.createPrivateKey(pem);
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), key)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

let jwtCache: { token: string; expiresAt: number } | null = null;

function getAppJwt(): string {
  const cfg = getGitHubConfig();
  if (!cfg) {
    throw new GitHubError("The GitHub App is not configured on this server.", 503);
  }
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache && now < jwtCache.expiresAt) return jwtCache.token;

  const token = signJwt(
    { iss: cfg.appId, iat: now - 60, exp: now + JWT_MAX_TTL_S },
    normalizePrivateKey(cfg.privateKey)
  );
  jwtCache = { token, expiresAt: now + JWT_MAX_TTL_S - JWT_REFRESH_BEFORE_S };
  return token;
}

async function githubFetch(
  url: string,
  token: string,
  opts?: { method?: string; body?: unknown }
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = {
    ...GITHUB_HEADERS,
    Authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts?.method ?? "GET",
      headers,
      body,
      signal: timeout,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new GitHubError("The GitHub API timed out.", 504);
    }
    throw new GitHubError("Could not reach the GitHub API.", 502);
  }
  if (!res.ok) {
    throw await buildGitHubApiError(res);
  }
  return res;
}

async function buildGitHubApiError(res: Response): Promise<GitHubError> {
  let message = `GitHub API error (status ${res.status}).`;
  try {
    const data = (await res.json()) as { message?: unknown };
    if (typeof data.message === "string" && data.message) {
      message = data.message;
    }
  } catch {
    /* non-JSON error body — keep generic message */
  }
  let status = 502;
  if (res.status === 401 || res.status === 403) status = 403;
  else if (res.status === 404) status = 404;
  else if (res.status === 409 || res.status === 422) status = 409;
  return new GitHubError(`${message} (GitHub ${res.status})`, status);
}

/* ------------------------------------------------------------------ */
/* Installations + installation access tokens.                         */
/* ------------------------------------------------------------------ */

const installationCache = new Map<string, { id: number; at: number }>();
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

async function resolveInstallationId(owner: string, repo: string): Promise<number> {
  const key = `${owner}/${repo}`;
  const cached = installationCache.get(key);
  if (cached && Date.now() - cached.at < INSTALLATION_CACHE_TTL_MS) {
    return cached.id;
  }

  const res = await githubFetch(
    `${getGitHubApiBase()}/repos/${owner}/${repo}/installation`,
    getAppJwt()
  );
  const data = (await res.json()) as { id?: unknown };
  if (typeof data.id !== "number") {
    throw new GitHubError(`The GitHub App is not installed on ${owner}/${repo}.`, 404);
  }
  installationCache.set(key, { id: data.id, at: Date.now() });
  return data.id;
}

async function createInstallationToken(installationId: number): Promise<string> {
  const nowMs = Date.now();
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > nowMs + TOKEN_REFRESH_BEFORE_MS) {
    return cached.token;
  }

  const res = await githubFetch(
    `${getGitHubApiBase()}/app/installations/${installationId}/access_tokens`,
    getAppJwt(),
    { method: "POST", body: {} }
  );
  const data = (await res.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof data.token !== "string" || !data.token) {
    throw new GitHubError("GitHub returned an invalid access token.", 502);
  }
  const parsed = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: Number.isFinite(parsed) ? parsed : nowMs + 60 * 60_000,
  });
  return data.token;
}

/** Installation access token for a repo (cached until near expiry). */
export async function getInstallationAccessToken(owner: string, repo: string): Promise<string> {
  const installationId = await resolveInstallationId(owner, repo);
  return createInstallationToken(installationId);
}

/** Installation access token for a known installation id. */
export async function getInstallationTokenById(installationId: number): Promise<string> {
  return createInstallationToken(installationId);
}

export interface InstallationInfo {
  id: number;
  login: string;
  htmlUrl: string;
}

/** All installations of the app (used by list_repositories). */
export async function listInstallations(): Promise<InstallationInfo[]> {
  const res = await githubFetch(`${getGitHubApiBase()}/app/installations?per_page=100`, getAppJwt());
  const data = (await res.json()) as Array<{
    id?: unknown;
    account?: { login?: unknown; html_url?: unknown };
  }>;
  return data
    .filter((i) => typeof i.id === "number")
    .map((i) => ({
      id: i.id as number,
      login:
        typeof i.account?.login === "string" ? (i.account.login as string) : "unknown",
      htmlUrl:
        typeof i.account?.html_url === "string" ? (i.account.html_url as string) : "",
    }));
}

export interface RepoSummary {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}

/** Repositories the app can access for one installation. */
export async function listInstallationRepositories(installationId: number): Promise<RepoSummary[]> {
  const token = await getInstallationTokenById(installationId);
  const res = await githubFetch(
    `${getGitHubApiBase()}/installation/repositories?per_page=100`,
    token
  );
  const data = (await res.json()) as {
    repositories?: Array<{
      full_name?: unknown;
      name?: unknown;
      private?: unknown;
      default_branch?: unknown;
    }>;
  };
  const repos = data.repositories ?? [];
  return repos.map((r) => ({
    fullName: typeof r.full_name === "string" ? (r.full_name as string) : "unknown",
    name: typeof r.name === "string" ? (r.name as string) : "unknown",
    private: r.private === true,
    defaultBranch: typeof r.default_branch === "string" ? (r.default_branch as string) : "main",
  }));
}
