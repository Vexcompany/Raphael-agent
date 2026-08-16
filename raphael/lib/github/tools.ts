import {
  ParsedToolCall,
  ToolDefinition,
  ToolResult,
} from "@/lib/ai/types";
import {
  GitHubError,
  getGitHubBotIdentity,
  listInstallationRepositories,
  listInstallations,
} from "./auth";
import { encodePath, encodeRef, ghData, ghRepo } from "./client";

/**
 * GitHub tool definitions + dispatcher.
 *
 * Each tool reads from a repo/installation through the GitHub App and
 * returns a safe JSON string the model consumes. Never returns tokens or
 * other secrets. When a tool fails the result carries `ok: false` with the
 * actual error message so the model can report honestly.
 */

const MAX_READ_BYTES = 512_000;
const MAX_TREE_ENTRIES = 2_000;

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

const STR = (description: string) => ({ type: "string", description });

const branch = STR;

function props(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const ownerRepo = {
  owner: STR("Repository owner (user or org), e.g. 'Vexcompany'."),
  repo: STR("Repository name, e.g. 'raphael-agent'."),
};

const GITHUB_TOOLS_LIST: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_repositories",
      description:
        "List repositories the Axiom AI RV GitHub App can access. Optionally filter by the owning account's login.",
      parameters: props(
        { owner: STR("Optional account login to filter by, e.g. 'Vexcompany'.") },
        []
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_repository",
      description:
        "Inspect a repository: metadata, default branch, description, language, size, last push, visibility.",
      parameters: props(ownerRepo, ["owner", "repo"]),
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_file_tree",
      description:
        "List the full file tree of a branch (recursive). Best first step to understand a repo's structure. Truncated past 2000 entries.",
      parameters: props(
        { ...ownerRepo, branch: branch("Branch or ref to inspect; defaults to the default branch.") },
        ["owner", "repo"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "list_repository_contents",
      description:
        "List the contents of one directory in a repo (files and subdirectories).",
      parameters: props(
        {
          ...ownerRepo,
          path: STR("Directory path relative to the repo root; empty/omitted for the root."),
          branch: branch("Branch or ref; defaults to the default branch."),
        },
        ["owner", "repo"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the text content of a single file in a repo at a given branch or ref. Files larger than ~500KB cannot be read in full.",
      parameters: props(
        {
          ...ownerRepo,
          path: STR("File path relative to the repo root, e.g. 'README.md'."),
          branch: branch("Branch or ref; defaults to the default branch."),
        },
        ["owner", "repo", "path"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "create_branch",
      description:
        "Create a new branch from an existing base branch (defaults to the repo default branch).",
      parameters: props(
        {
          ...ownerRepo,
          newBranch: STR("Name of the branch to create, e.g. 'feature/update-readme'."),
          base: branch("Existing branch to branch from; defaults to the default branch."),
        },
        ["owner", "repo", "newBranch"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "create_or_update_file",
      description:
        "Create or update a single file on a branch with a commit message. Use for one-file changes; for multiple files use commit_changes.",
      parameters: props(
        {
          ...ownerRepo,
          path: STR("File path relative to the repo root, e.g. 'docs/guide.md'."),
          content: STR("Full new text content of the file."),
          message: STR("Commit message."),
          branch: branch("Branch to write to; defaults to the default branch."),
        },
        ["owner", "repo", "path", "content", "message"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "commit_changes",
      description:
        "Commit several file changes at once on a branch via the Git data API. Files is an array of {path, content} with full new content. One commit, one branch update.",
      parameters: props(
        {
          ...ownerRepo,
          branch: branch("Branch to commit to."),
          message: STR("Commit message."),
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: STR("File path relative to the repo root."),
                content: STR("Full new text content."),
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
            description: "Files to create or overwrite in this commit.",
          },
        },
        ["owner", "repo", "branch", "message", "files"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "open_pull_request",
      description:
        "Open a pull request from a head branch into a base branch (defaults to the repo default branch).",
      parameters: props(
        {
          ...ownerRepo,
          title: STR("PR title."),
          head: STR("Source branch, e.g. 'feature/update-readme'."),
          base: branch("Target branch; defaults to the default branch."),
          body: STR("PR description (Markdown)."),
        },
        ["owner", "repo", "title", "head"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "list_pull_requests",
      description: "List open pull requests in a repo (optionally all states).",
      parameters: props(
        {
          ...ownerRepo,
          state: STR("One of 'open' (default), 'closed', 'all'."),
        },
        ["owner", "repo"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "get_pull_request",
      description:
        "Get a pull request's details, its changed files, and comments. Includes mergeable state and CI checks.",
      parameters: props(
        {
          ...ownerRepo,
          number: { type: "number", description: "Pull request number.", required: true },
        },
        ["owner", "repo", "number"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "merge_pull_request",
      description: "Merge a pull request using a squash merge.",
      parameters: props(
        {
          ...ownerRepo,
          number: { type: "number", description: "Pull request number.", required: true },
          commitTitle: STR("Optional commit title for the merge."),
        },
        ["owner", "repo", "number"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_workflow_runs",
      description:
        "Inspect GitHub Actions workflow runs for a branch or a single run id: status, conclusion, jobs, and a truncated log tail.",
      parameters: props(
        {
          ...ownerRepo,
          branch: branch("Filter runs by head branch; defaults to all recent runs."),
          runId: { type: "number", description: "Specific workflow run id to inspect (with jobs + log tail)." },
        },
        ["owner", "repo"]
      ),
    },
  },
];

export const GITHUB_TOOLS: readonly ToolDefinition[] = GITHUB_TOOLS_LIST;

/* ------------------------------------------------------------------ */
/* Argument helpers                                                    */
/* ------------------------------------------------------------------ */

type Args = Record<string, unknown>;

function reqString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new GitHubError(`Tool argument "${key}" must be a non-empty string.`, 400);
  }
  return v;
}

function optString(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new GitHubError(`Tool argument "${key}" must be a string.`, 400);
  }
  return v;
}

function reqNumber(args: Args, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new GitHubError(`Tool argument "${key}" must be a positive integer.`, 400);
  }
  return v;
}

function okResult(call: ParsedToolCall, data: unknown): ToolResult {
  return { call, ok: true, output: JSON.stringify(data, null, 2) };
}

function errResult(call: ParsedToolCall, message: string): ToolResult {
  return { call, ok: false, output: `Error: ${message}` };
}

/* ------------------------------------------------------------------ */
/* Implementations                                                     */
/* ------------------------------------------------------------------ */

async function toolListRepositories(args: Args): Promise<unknown> {
  const owner = optString(args, "owner");
  const installations = await listInstallations();
  const repos: Array<Record<string, unknown>> = [];

  for (const inst of installations) {
    if (owner && inst.login !== owner) continue;
    const list = await listInstallationRepositories(inst.id);
    for (const r of list) {
      repos.push({
        full_name: r.fullName,
        name: r.name,
        private: r.private,
        default_branch: r.defaultBranch,
        installation: inst.login,
      });
    }
  }

  return {
    count: repos.length,
    repositories: repos.sort((a, b) =>
      String(a.full_name).localeCompare(String(b.full_name))
    ),
  };
}

interface RepoMeta {
  name?: unknown;
  full_name?: unknown;
  description?: unknown;
  default_branch?: unknown;
  private?: unknown;
  language?: unknown;
  size?: unknown;
  stargazers_count?: unknown;
  pushed_at?: unknown;
  html_url?: unknown;
  topics?: unknown;
}

async function getRepoMeta(owner: string, repo: string): Promise<RepoMeta> {
  const data = await ghData<RepoMeta>(owner, repo, "");
  return data ?? {};
}

async function toolInspectRepository(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const d = await getRepoMeta(owner, repo);
  return {
    name: d.name ?? null,
    full_name: d.full_name ?? `${owner}/${repo}`,
    description: d.description ?? null,
    private: d.private === true,
    default_branch: d.default_branch ?? null,
    language: d.language ?? null,
    size_kb: d.size ?? null,
    stargazers: d.stargazers_count ?? 0,
    last_push: d.pushed_at ?? null,
    url: d.html_url ?? null,
    topics: Array.isArray(d.topics) ? d.topics : [],
  };
}

async function resolveBranch(
  owner: string,
  repo: string,
  requested?: string
): Promise<string> {
  if (requested) return requested;
  const meta = await getRepoMeta(owner, repo);
  return typeof meta.default_branch === "string" ? meta.default_branch : "main";
}

async function toolInspectFileTree(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const branch = await resolveBranch(owner, repo, optString(args, "branch"));

  const data = await ghData<{ tree?: unknown; truncated?: unknown }>(
    owner,
    repo,
    `/git/trees/${encodeRef(branch)}?recursive=1`
  );
  const tree = Array.isArray(data?.tree) ? (data.tree as Array<{ path?: unknown; type?: unknown }>) : [];
  const paths = tree
    .map((t) => ({ path: t.path ?? "", type: t.type ?? "blob" }))
    .filter((t) => typeof t.path === "string" && t.path.length > 0)
    .slice(0, MAX_TREE_ENTRIES);

  return {
    branch,
    truncated: data?.truncated === true || tree.length > MAX_TREE_ENTRIES,
    total_entries: tree.length,
    paths,
  };
}

async function toolListRepositoryContents(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const path = (optString(args, "path") ?? "").replace(/^\/+/, "");
  const branch = await resolveBranch(owner, repo, optString(args, "branch"));

  const suffix = encodePath(path) ? `/contents/${encodePath(path)}` : "/contents";
  const query = `?ref=${encodeURIComponent(branch)}`;
  const data = await ghData<Array<{ name?: unknown; type?: unknown; path?: unknown; size?: unknown }> | RepoMeta>(
    owner,
    repo,
    `${suffix}${query}`
  );

  if (Array.isArray(data)) {
    return {
      branch,
      path: path || "/",
      entries: data.map((e) => ({
        name: e.name ?? null,
        type: e.type ?? null,
        path: e.path ?? null,
        size: typeof e.size === "number" ? e.size : null,
      })),
    };
  }
  // A file path was given — point the model at read_file.
  return { branch, path: path || "/", is_file: true, hint: "Use read_file to get file content." };
}

async function toolReadFile(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const path = reqString(args, "path").replace(/^\/+/, "");
  const branch = await resolveBranch(owner, repo, optString(args, "branch"));

  const res = await ghRepo(owner, repo, `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`, {
    accept: "application/vnd.github.raw+json",
  });
  const text = typeof res.text === "string" ? res.text : "";
  if (Buffer.byteLength(text, "utf8") > MAX_READ_BYTES) {
    throw new GitHubError(
      `File "${path}" is larger than ${MAX_READ_BYTES} bytes and cannot be read in full. Use inspect_file_tree or list_repository_contents to explore instead.`
    );
  }
  return { path, branch, size_bytes: Buffer.byteLength(text, "utf8"), content: text };
}

async function toolCreateBranch(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const newBranch = reqString(args, "newBranch").replace(/^refs\/heads\//, "");
  const base = await resolveBranch(owner, repo, optString(args, "base"));

  const refData = await ghData<{ object?: { sha?: unknown } }>(
    owner,
    repo,
    `/git/ref/heads/${encodeURIComponent(base)}`
  );
  const sha = refData?.object?.sha;
  if (typeof sha !== "string" || !sha) {
    throw new GitHubError(`Could not resolve branch "${base}" head.`);
  }

  const created = await ghData<{ ref?: unknown; object?: { sha?: unknown } }>(
    owner,
    repo,
    "/git/refs",
    { method: "POST", body: { ref: `refs/heads/${newBranch}`, sha } }
  );
  return {
    branch: newBranch,
    based_on: base,
    ref: created?.ref ?? `refs/heads/${newBranch}`,
    sha: created?.object?.sha ?? sha,
  };
}

async function toolCreateOrUpdateFile(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const path = reqString(args, "path").replace(/^\/+/, "");
  const content = reqString(args, "content");
  const message = reqString(args, "message");
  const branch = await resolveBranch(owner, repo, optString(args, "branch"));

  let sha: string | undefined;
  try {
    const existing = await ghData<{ sha?: unknown }>(
      owner,
      repo,
      `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`
    );
    if (typeof existing?.sha === "string") sha = existing.sha;
  } catch (err) {
    if (!(err instanceof GitHubError) || err.status !== 404) throw err;
    // 404 = file does not exist yet — creating it is fine.
  }

  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await ghData<{ content?: { path?: unknown }; commit?: { sha?: unknown; html_url?: unknown } }>(
    owner,
    repo,
    `/contents/${encodePath(path)}`,
    { method: "PUT", body }
  );
  return {
    path,
    branch,
    updated: sha ? true : false,
    commit_sha: res?.commit?.sha ?? null,
    html_url: res?.commit?.html_url ?? null,
  };
}

async function toolCommitChanges(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const branch = reqString(args, "branch").replace(/^refs\/heads\//, "");
  const message = reqString(args, "message");
  const rawFiles = args.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new GitHubError('Tool argument "files" must be a non-empty array of {path, content}.', 400);
  }
  const files: Array<{ path: string; content: string }> = rawFiles.map((f, i) => {
    if (typeof f !== "object" || f === null) {
      throw new GitHubError(`Tool argument "files[${i}]" must be an object.`, 400);
    }
    const o = f as Record<string, unknown>;
    const p = typeof o.path === "string" ? o.path.replace(/^\/+/, "") : "";
    const c = typeof o.content === "string" ? o.content : "";
    if (!p || !c) {
      throw new GitHubError(`Tool argument "files[${i}]" must have non-empty "path" and "content".`, 400);
    }
    return { path: p, content: c };
  });

  // 1. Branch head.
  const head = await ghData<{ object?: { sha?: unknown } }>(
    owner,
    repo,
    `/git/ref/heads/${encodeURIComponent(branch)}`
  );
  const headSha = head?.object?.sha;
  if (typeof headSha !== "string" || !headSha) {
    throw new GitHubError(`Could not resolve branch "${branch}" head.`);
  }

  // 2. Blobs.
  const blobs: Array<{ path: string; sha: string }> = [];
  for (const f of files) {
    const blob = await ghData<{ sha?: unknown }>(owner, repo, "/git/blobs", {
      method: "POST",
      body: { content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" },
    });
    if (typeof blob?.sha !== "string" || !blob.sha) {
      throw new GitHubError(`Could not create blob for "${f.path}".`);
    }
    blobs.push({ path: f.path, sha: blob.sha });
  }

  // 3. Tree on top of the branch head.
  const tree = await ghData<{ sha?: unknown }>(owner, repo, "/git/trees", {
    method: "POST",
    body: {
      base_tree: headSha,
      tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
    },
  });
  const treeSha = tree?.sha;
  if (typeof treeSha !== "string" || !treeSha) {
    throw new GitHubError("Could not create the tree.");
  }

  // 4. Commit.
  const identity = getGitHubBotIdentity();
  const commit = await ghData<{ sha?: unknown; html_url?: unknown }>(owner, repo, "/git/commits", {
    method: "POST",
    body: {
      message,
      tree: treeSha,
      parents: [headSha],
      author: identity,
      committer: identity,
    },
  });
  const commitSha = commit?.sha;
  if (typeof commitSha !== "string" || !commitSha) {
    throw new GitHubError("Could not create the commit.");
  }

  // 5. Move the branch ref.
  await ghData(owner, repo, `/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: { sha: commitSha, force: false },
  });

  return {
    branch,
    commit_sha: commitSha,
    html_url: commit?.html_url ?? null,
    files_changed: files.map((f) => f.path),
  };
}

async function toolOpenPullRequest(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const title = reqString(args, "title");
  const head = reqString(args, "head").replace(/^refs\/heads\//, "");
  const base = await resolveBranch(owner, repo, optString(args, "base"));
  const body = optString(args, "body") ?? "";

  const pr = await ghData<{ number?: unknown; html_url?: unknown; state?: unknown; title?: unknown }>(
    owner,
    repo,
    "/pulls",
    { method: "POST", body: { title, head, base, body } }
  );
  return {
    number: pr?.number ?? null,
    title: pr?.title ?? title,
    state: pr?.state ?? "open",
    html_url: pr?.html_url ?? null,
  };
}

async function toolListPullRequests(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const state = optString(args, "state") ?? "open";

  const data = await ghData<Array<{ number?: unknown; title?: unknown; state?: unknown; user?: { login?: unknown }; head?: { ref?: unknown }; base?: { ref?: unknown }; html_url?: unknown }>>(
    owner,
    repo,
    `/pulls?state=${encodeURIComponent(state)}&per_page=20`
  );
  return {
    count: Array.isArray(data) ? data.length : 0,
    pull_requests: Array.isArray(data)
      ? data.map((p) => ({
          number: p.number ?? null,
          title: p.title ?? null,
          state: p.state ?? null,
          author: p.user?.login ?? null,
          head: p.head?.ref ?? null,
          base: p.base?.ref ?? null,
          html_url: p.html_url ?? null,
        }))
      : [],
  };
}

async function toolGetPullRequest(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const number = reqNumber(args, "number");

  const pr = await ghData<{ title?: unknown; state?: unknown; mergeable?: unknown; mergeable_state?: unknown; body?: unknown; head?: { ref?: unknown; sha?: unknown }; base?: { ref?: unknown }; html_url?: unknown; created_at?: unknown; user?: { login?: unknown } }>(
    owner,
    repo,
    `/pulls/${number}`
  );
  const files = await ghData<Array<{ filename?: unknown; status?: unknown; additions?: unknown; deletions?: unknown }>>(
    owner,
    repo,
    `/pulls/${number}/files?per_page=50`
  );
  const reviews = await ghData<Array<{ state?: unknown; user?: { login?: unknown }; submitted_at?: unknown }>>(
    owner,
    repo,
    `/pulls/${number}/reviews?per_page=20`
  );

  return {
    number,
    title: pr?.title ?? null,
    state: pr?.state ?? null,
    author: pr?.user?.login ?? null,
    head: pr?.head?.ref ?? null,
    head_sha: pr?.head?.sha ?? null,
    base: pr?.base?.ref ?? null,
    mergeable: pr?.mergeable ?? null,
    mergeable_state: pr?.mergeable_state ?? null,
    body: pr?.body ?? "",
    html_url: pr?.html_url ?? null,
    created_at: pr?.created_at ?? null,
    files_changed: Array.isArray(files)
      ? files.map((f) => ({
          filename: f.filename ?? null,
          status: f.status ?? null,
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
        }))
      : [],
    reviews: Array.isArray(reviews)
      ? reviews.map((r) => ({ state: r.state ?? null, by: r.user?.login ?? null, at: r.submitted_at ?? null }))
      : [],
  };
}

async function toolMergePullRequest(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const number = reqNumber(args, "number");
  const commitTitle = optString(args, "commitTitle");

  const body: Record<string, unknown> = { merge_method: "squash" };
  if (commitTitle) body.commit_title = commitTitle;

  const res = await ghData<{ merged?: unknown; message?: unknown; sha?: unknown }>(
    owner,
    repo,
    `/pulls/${number}/merge`,
    { method: "PUT", body }
  );
  return {
    number,
    merged: res?.merged === true,
    message: res?.message ?? null,
    sha: res?.sha ?? null,
  };
}

async function toolInspectWorkflowRuns(args: Args): Promise<unknown> {
  const owner = reqString(args, "owner");
  const repo = reqString(args, "repo");
  const runId = typeof args.runId === "number" ? args.runId : undefined;

  if (runId !== undefined) {
    const run = await ghData<{ id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; head_branch?: unknown; html_url?: unknown; head_sha?: unknown; created_at?: unknown }>(
      owner,
      repo,
      `/actions/runs/${runId}`
    );
    const jobs = await ghData<{ jobs?: Array<{ name?: unknown; status?: unknown; conclusion?: unknown; started_at?: unknown; completed_at?: unknown }> }>(
      owner,
      repo,
      `/actions/runs/${runId}/jobs`
    );
    const logs = await ghRepo(owner, repo, `/actions/runs/${runId}/logs`, {
      accept: "application/vnd.github+json",
    });
    return {
      run: {
        id: run?.id ?? runId,
        name: run?.name ?? null,
        status: run?.status ?? null,
        conclusion: run?.conclusion ?? null,
        head_branch: run?.head_branch ?? null,
        head_sha: run?.head_sha ?? null,
        created_at: run?.created_at ?? null,
        html_url: run?.html_url ?? null,
      },
      jobs: Array.isArray(jobs?.jobs)
        ? jobs.jobs.map((j) => ({
            name: j.name ?? null,
            status: j.status ?? null,
            conclusion: j.conclusion ?? null,
            started_at: j.started_at ?? null,
            completed_at: j.completed_at ?? null,
          }))
        : [],
      log_tail: typeof logs.text === "string" ? logs.text.slice(-4000) : "",
    };
  }

  const branch = optString(args, "branch");
  const query = `/actions/runs?per_page=10${branch ? `&head_branch=${encodeURIComponent(branch)}` : ""}`;
  const data = await ghData<{ workflow_runs?: Array<{ id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; head_branch?: unknown; run_number?: unknown; html_url?: unknown; created_at?: unknown }> }>(
    owner,
    repo,
    query
  );
  const runs = data?.workflow_runs ?? [];
  return {
    count: runs.length,
    runs: runs.map((r) => ({
      id: r.id ?? null,
      name: r.name ?? null,
      run_number: r.run_number ?? null,
      status: r.status ?? null,
      conclusion: r.conclusion ?? null,
      head_branch: r.head_branch ?? null,
      created_at: r.created_at ?? null,
      html_url: r.html_url ?? null,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

/** Execute one tool call and return a safe result string for the model. */
export async function executeGitHubTool(call: ParsedToolCall): Promise<ToolResult> {
  const args = call.arguments ?? {};
  try {
    switch (call.name) {
      case "list_repositories":
        return okResult(call, await toolListRepositories(args));
      case "inspect_repository":
        return okResult(call, await toolInspectRepository(args));
      case "inspect_file_tree":
        return okResult(call, await toolInspectFileTree(args));
      case "list_repository_contents":
        return okResult(call, await toolListRepositoryContents(args));
      case "read_file":
        return okResult(call, await toolReadFile(args));
      case "create_branch":
        return okResult(call, await toolCreateBranch(args));
      case "create_or_update_file":
        return okResult(call, await toolCreateOrUpdateFile(args));
      case "commit_changes":
        return okResult(call, await toolCommitChanges(args));
      case "open_pull_request":
        return okResult(call, await toolOpenPullRequest(args));
      case "list_pull_requests":
        return okResult(call, await toolListPullRequests(args));
      case "get_pull_request":
        return okResult(call, await toolGetPullRequest(args));
      case "merge_pull_request":
        return okResult(call, await toolMergePullRequest(args));
      case "inspect_workflow_runs":
        return okResult(call, await toolInspectWorkflowRuns(args));
      default:
        return errResult(call, `Unknown tool "${call.name}".`);
    }
  } catch (err) {
    if (err instanceof GitHubError) {
      return errResult(call, err.message);
    }
    return errResult(
      call,
      `The tool failed unexpectedly: ${err instanceof Error ? err.message : "unknown error"}.`
    );
  }
}
