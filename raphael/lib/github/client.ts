import {
  GitHubError,
  getGitHubApiBase,
  getInstallationAccessToken,
  getInstallationTokenById,
} from "./auth";

/**
 * Thin, typed GitHub REST client for the agent.
 *
 * Only uses what the tools need. Authentication always flows through the
 * GitHub App installation tokens from ./auth — never personal tokens, and
 * tokens never leave the server.
 */

const REQUEST_TIMEOUT_MS = 20_000;

/** GitHub-style API reference, e.g. "main", "heads/main", a branch name. */
export function encodeRef(ref: string): string {
  return encodeURIComponent(ref.replace(/^refs\//, ""));
}

/** Encode a repo-relative file path, keeping "/" as a separator. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export interface GitHubRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON-serializable body. */
  body?: unknown;
  /** Response content type override (e.g. raw file content). */
  accept?: string;
}

interface GitHubResponse<T> {
  status: number;
  data: T;
  /** Raw text (used for raw content requests). */
  text: string;
}

async function request(
  url: string,
  token: string,
  opts: GitHubRequestOptions = {}
): Promise<GitHubResponse<unknown>> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Accept: opts.accept ?? "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: timeout,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new GitHubError("The GitHub API timed out.", 504);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new GitHubError("The GitHub request was cancelled.", 499);
    }
    throw new GitHubError("Could not reach the GitHub API.", 502);
  }

  const text = await res.text();
  if (!res.ok) {
    throw await parseGitHubError(res.status, text);
  }

  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data, text };
}

async function parseGitHubError(status: number, body: string): Promise<GitHubError> {
  let message = `GitHub API error (status ${status}).`;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; documentation_url?: unknown };
    if (typeof parsed.message === "string" && parsed.message) {
      message = parsed.message;
    }
  } catch {
    if (body) message = body.slice(0, 500);
  }
  let mapped = 502;
  if (status === 401 || status === 403) mapped = 403;
  else if (status === 404) mapped = 404;
  else if (status === 409 || status === 422) mapped = 409;
  return new GitHubError(`${message} (GitHub ${status})`, mapped);
}

/** Repo-scoped request, authenticated with the repo installation token. */
export async function ghRepo(
  owner: string,
  repo: string,
  path: string,
  opts?: GitHubRequestOptions
): Promise<GitHubResponse<unknown>> {
  const token = await getInstallationAccessToken(owner, repo);
  return request(`${getGitHubApiBase()}/repos/${encodePath(owner)}/${encodePath(repo)}${path}`, token, opts);
}

/** Installation-scoped request (e.g. GET /installation/repositories). */
export async function ghInstallation(
  installationId: number,
  path: string,
  opts?: GitHubRequestOptions
): Promise<GitHubResponse<unknown>> {
  const token = await getInstallationTokenById(installationId);
  return request(`${getGitHubApiBase()}/installation${path}`, token, opts);
}

/** Typed convenience wrapper returning the parsed data (throws on error). */
export async function ghData<T>(
  owner: string,
  repo: string,
  path: string,
  opts?: GitHubRequestOptions
): Promise<T> {
  const res = await ghRepo(owner, repo, path, opts);
  return res.data as T;
}
