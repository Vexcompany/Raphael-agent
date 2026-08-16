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

Not yet included (planned for later versions): tools, GitHub/Vercel integration, advanced model routing, persistence, auth, agents. Raphael will honestly say so if asked.

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
  api/chat/route.ts   # Chat API: model validation, streaming, error handling
  api/models/route.ts # Model catalog + availability
lib/ai/
  types.ts            # AIProvider interface + ChatMessage types + errors
  provider.ts         # Ryzumi provider implementation + factory
  models.ts           # Model registry + availability (fallback + live /models)
  systemPrompt.ts     # Raphael's identity (v0.1)
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

All variables are read **only on the server** (inside the API routes). None are prefixed with `NEXT_PUBLIC_`, so they are never bundled into client code. If `RYZUMI_API_KEY` or `RYZUMI_BASE_URL` is missing, the chat API returns a clear 503 error instead of crashing.

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

## Production (Vercel)

1. Push this repository to GitHub.
2. In [Vercel](https://vercel.com), **Add New Project** → import the repo.
3. Framework preset: **Next.js** (auto-detected). Build command `next build`, output handled automatically — no custom configuration needed.
4. Add the environment variables (`RYZUMI_API_KEY`, `RYZUMI_BASE_URL`) under **Settings → Environment Variables** for the Production (and Preview) environments.
5. Deploy.

The chat route runs on the Node.js runtime with a 60s max duration (set via `maxDuration` in `app/api/chat/route.ts`).

## Security notes (v0.1 baseline)

- API keys live only in server-side env vars; never sent to or readable by the browser.
- `POST /api/chat` strictly validates input (roles, types, sizes, non-empty last user message) and caps body size.
- The requested `model` is validated against the model catalog server-side — arbitrary ids are rejected and never passed to the upstream API.
- Provider error bodies are never forwarded to the client — they are mapped to safe messages (no stack traces, no secrets).
- `GET /api/models` never exposes credentials or raw upstream error bodies.
- Assistant Markdown is rendered with `react-markdown` **without** raw-HTML support, so model/user-controlled content cannot inject HTML/scripts.
- The system prompt role is enforced server-side; clients can only submit `user`/`assistant` turns.
- No CORS headers are added, so the API defaults to same-origin usage.
- `.env*` files are git-ignored; `.env.example` contains no real credentials.
