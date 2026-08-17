# Raphael v0.1

## What it is

A simple full-stack AI chat application — the first working version of **Raphael**, a general-purpose AI agent under development.

In v0.1 Raphael is a conversational assistant:

- Polished, responsive chat UI (desktop / tablet / mobile)
- Streaming AI responses with Markdown + code-block rendering
- Conversation context maintained across turns
- Conversation survives a page refresh (stored locally in the browser)
- Model selector with live availability (Auto / all Ryzumi models, ACTIVE & OUT OF STOCK)
- New-chat, loading, error, and retry states
- Server-side AI provider abstraction — the provider is configured via environment variables and can be swapped without rewriting the app
- **GitHub tools** (when the "Axiom AI RV" GitHub App is configured): inspect repositories, read/modify files, create branches, commit changes, open/merge PRs, and inspect Actions runs

Not yet included (planned for later versions): Vercel deployment, persistence, auth, advanced agents. The agent will honestly say so if asked.

## Tech stack

- [Next.js](https://nextjs.org) (App Router) + React + TypeScript
- `POST /api/chat` streams the assistant reply; `GET /api/models` serves the model catalog
- Provider layer: **Ryzumi AI** via its OpenAI-compatible Chat Completions API
- No database — the backend is stateless; the client sends the current conversation with each request

```
app/
  page.tsx            # Chat UI + model selector (client component)
  layout.tsx          # Root layout / metadata
  globals.css         # Styles
  api/chat/route.ts   # Chat API: model validation, agent loop, streaming, errors
  api/models/route.ts # Model catalog + availability
lib/ai/
  types.ts            # AIProvider interface + ChatMessage/Tool types + errors
  provider.ts         # Ryzumi provider implementation + factory (tools + streaming)
  models.ts           # Model registry + availability (fallback + live /models)
  systemPrompt.ts     # Axiom AI RV identity + capability prompt
lib/agent/
  runChat.ts          # Server-side model <-> tools loop (streams to the client)
  needsTools.ts       # Whether a request plausibly needs the GitHub tool schema
lib/github/
  auth.ts             # GitHub App JWT + installation access tokens (cached)
  client.ts           # Typed GitHub REST helpers
  tools.ts            # 13 GitHub tool definitions + dispatcher
```

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in RYZUMI_API_KEY
npm run dev                  # http://localhost:3000
```

Other scripts:

```bash
npm run build   # production build
npm run start   # run the production build
npm run lint    # ESLint
npx tsc --noEmit  # type check
```

## Environment variables

| Variable           | Required | Description                                                                 |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `RYZUMI_API_KEY`   | ✅ yes   | Secret key for the Ryzumi AI API. Server-side only.                         |
| `RYZUMI_BASE_URL`  | ✅ yes   | Base URL of the Ryzumi OpenAI-compatible API (default `https://ai.ryzumi.net/v1`). |
| `RYZUMI_MODEL`     | no       | Server-side default model used only when a request omits `model`. The chat UI always sends the exact selected model id. |
| `RYZUMI_MAX_TOKENS` | no      | Output token cap sent as `max_tokens` (default `1024`). Keeps every response — including tool-loop rounds — bounded. |
| `RYZUMI_TIMEOUT_MS` | no      | Connect timeout in ms: how long to wait for the upstream response headers (default `30000`). |
| `RYZUMI_IDLE_TIMEOUT_MS` | no | Max silence between stream chunks in ms (default `30000`). Catches a stream that stops mid-response. |
| `GITHUB_APP_ID`    | no       | GitHub App id. Enables the GitHub tools.                                    |
| `GITHUB_CLIENT_ID` | no       | OAuth client id of the same GitHub App (not used server-side).             |
| `GITHUB_CLIENT_SECRET` | no    | OAuth client secret of the same GitHub App (not used server-side).         |
| `GITHUB_PRIVATE_KEY` | no     | GitHub App private key (PEM). Enables the GitHub tools.                    |
| `GITHUB_BOT_NAME` / `GITHUB_BOT_EMAIL` | no | Identity used for commits authored by the agent.              |
| `GITHUB_API_BASE_URL` | no | GitHub REST base URL override for tests/local proxies (default `https://api.github.com`). |

All variables are read **only on the server** (inside the API routes). None are prefixed with `NEXT_PUBLIC_`, so they are never bundled into client code. If `RYZUMI_API_KEY` or `RYZUMI_BASE_URL` is missing, the chat API returns a clear 503 error instead of crashing. If the GitHub App variables are missing, the chat API simply runs without GitHub tools.

### Example configuration

```bash
RYZUMI_API_KEY=your-ryzumi-api-key
RYZUMI_BASE_URL=https://ai.ryzumi.net/v1
```

## Model selection

Raphael ships with an in-UI model selector (header, next to *New chat*). It is modeled after Postman's model picker:

- **Auto** routes through the gateway's default model.
- Every Ryzumi model is listed, grouped (Claude, GPT, DeepSeek, Qwen, Kimi, GLM, Grok, Mistral, Other).
- **ACTIVE** models are selectable; **OUT OF STOCK** models stay visible but disabled.
- The selected model is preserved for the session (survives a page refresh) and sent verbatim to `POST /api/chat` as `model`.
- A **Refresh** button re-fetches availability at any time.

### Where availability comes from

1. The server first tries an authenticated `GET {RYZUMI_BASE_URL}/models`. If Ryzumi exposes stock/status metadata there, it becomes the source of truth.
2. If the endpoint is unsupported/unreachable, Raphael falls back to a **static catalog** in `lib/ai/models.ts` containing every known model id with availability captured from a Ryzumi snapshot. That snapshot is a fallback, not permanent truth — the code is structured so realtime availability can be wired in whenever the API provides it.
3. The result is cached server-side for 30s (`?refresh=1` bypasses the cache). If a model fails mid-chat, the cache is invalidated, availability is refreshed, and the model is disabled.

### Error handling

- The server validates `model` against the catalog before streaming — unknown ids and out-of-stock models are rejected with a clear error and never reach the upstream call.
- If a model disappears mid-stream, the client shows a concise error, refreshes availability, disables the model, keeps the conversation, and lets you pick another model and retry.
- Failures are reported truthfully and distinctly, never as a generic "empty response": an upstream timeout surfaces as a timeout error (with any already-streamed partial output preserved), a malformed/unparseable stream as a malformed error, an upstream HTTP error as a provider error, and a genuinely empty response as "(The model returned an empty response.)".

## GitHub tools ("Axiom AI RV")

When the `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` variables are configured, the agent gains real, server-side GitHub tools through the **Axiom AI RV** GitHub App. All calls are authenticated with short-lived **installation access tokens** minted from an app JWT — never a personal access token. Tokens are cached server-side until near expiry.

Available tools (declared to the model via OpenAI-style function calling):

| Tool                      | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `list_repositories`       | Repos the app can access (optionally filtered by owner)              |
| `inspect_repository`      | Repo metadata, default branch, language, size, last push             |
| `inspect_file_tree`       | Recursive file tree of a branch                                      |
| `list_repository_contents`| One directory's files/subdirectories                                 |
| `read_file`               | Text content of a single file (capped at ~512KB)                     |
| `create_branch`           | Create a branch from an existing base                                |
| `create_or_update_file`   | Create/update one file with a commit message                         |
| `commit_changes`          | Commit several files at once via the Git data API                    |
| `open_pull_request`       | Open a PR (head → base)                                              |
| `list_pull_requests`      | List PRs (open/closed/all)                                           |
| `get_pull_request`        | PR details, changed files, reviews, mergeable state                  |
| `merge_pull_request`      | Squash-merge a PR                                                    |
| `inspect_workflow_runs`   | Actions runs/jobs + log tail for a branch or a specific run          |

How it works:

1. The server builds the system prompt with the real connected/not-connected state and passes the 13 tool definitions to the model **only when the request plausibly needs GitHub** (e.g. mentions a repo, PR, commit, file, etc.). Ordinary chat skips the ~1,600-token tool schema entirely and is told tools are not active for that turn.
2. The model may call tools mid-conversation. `lib/agent/runChat.ts` executes each call server-side and feeds real results back so the model can continue reasoning. Tool results are capped (~60KB) before being re-sent so later rounds never balloon.
3. The client sees only the final streamed text plus a compact tool-activity line (`[RAPHAEL_TOOL]`); tool payloads, tokens, and GitHub responses are never sent to the browser.

To set it up locally: create a GitHub App (repo scope + contents, pull requests, actions), install it on the account that owns the repo you want to test with, then put the app id, client id/secret, and PEM private key in your environment. The app must be installed on the target repo (e.g. `axiom-agent-test`).

## Production (Vercel)

1. Push this repository to GitHub.
2. In [Vercel](https://vercel.com), **Add New Project** → import the repo.
3. Framework preset: **Next.js** (auto-detected). Build command `next build`, output handled automatically — no custom configuration needed.
4. Add the environment variables (`RYZUMI_API_KEY`, `RYZUMI_BASE_URL`, and optionally the `GITHUB_*` variables) under **Settings → Environment Variables** for the Production (and Preview) environments.
5. Deploy.

The chat route runs on the Node.js runtime with a 120s max duration (set via `maxDuration` in `app/api/chat/route.ts`), which accounts for multi-round tool use.

## Security notes (v0.1 baseline)

- API keys live only in server-side env vars; never sent to or readable by the browser.
- GitHub integration uses **GitHub App installation tokens** (short-lived, scoped per installation) — never a personal access token. Tokens, app JWTs, and the private key never leave the server or reach the model's context.
- Tool results are consumed only by the model server-side; the browser receives streamed text and a compact `[RAPHAEL_TOOL]` activity line with no payloads.
- `POST /api/chat` strictly validates input (roles, types, sizes, non-empty last user message) and caps body size.
- The requested `model` is validated against the model catalog server-side — arbitrary ids are rejected and never passed to the upstream API.
- Provider error bodies are never forwarded to the client — they are mapped to safe messages (no stack traces, no secrets).
- `GET /api/models` never exposes credentials or raw upstream error bodies.
- Assistant Markdown is rendered with `react-markdown` **without** raw-HTML support, so model/user-controlled content cannot inject HTML/scripts.
- The system prompt role is enforced server-side; clients can only submit `user`/`assistant` turns.
- No CORS headers are added, so the API defaults to same-origin usage.
- `.env*` files are git-ignored; `.env.example` contains no real credentials.
