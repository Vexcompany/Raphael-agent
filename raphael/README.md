# Raphael v0.1

## What it is

A simple full-stack AI chat application — the first working version of **Raphael**, a general-purpose AI agent under development.

In v0.1 Raphael is a conversational assistant:

- Polished, responsive chat UI (desktop / tablet / mobile)
- Streaming AI responses with Markdown + code-block rendering
- Conversation context maintained across turns
- Conversation survives a page refresh (stored locally in the browser)
- New-chat, loading, error, and retry states
- Server-side AI provider abstraction — the model is configured via environment variables and can be swapped without rewriting the app

Not yet included (planned for later versions): tools, GitHub/Vercel integration, model routing, persistence, auth, agents. Raphael will honestly say so if asked.

## Tech stack

- [Next.js](https://nextjs.org) (App Router) + React + TypeScript
- One API route: `POST /api/chat` (streams the assistant reply)
- Provider layer: any **OpenAI-compatible** Chat Completions API (OpenAI, OpenRouter, Groq, DeepSeek, …)
- No database — the backend is stateless; the client sends the current conversation with each request

```
app/
  page.tsx            # Chat UI (client component)
  layout.tsx          # Root layout / metadata
  globals.css         # Styles
  api/chat/route.ts   # Chat API: validation, streaming, error handling
lib/ai/
  types.ts            # AIProvider interface + ChatMessage types
  provider.ts         # OpenAI-compatible provider implementation + factory
  systemPrompt.ts     # Raphael's identity (v0.1)
```

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in AI_API_KEY
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

| Variable      | Required | Default                     | Description                                              |
| ------------- | -------- | --------------------------- | -------------------------------------------------------- |
| `AI_API_KEY`  | ✅ yes   | —                           | Secret key for the AI provider. Server-side only.        |
| `AI_BASE_URL` | no       | `https://api.openai.com/v1` | Base URL of any OpenAI-compatible Chat Completions API.  |
| `AI_MODEL`    | no       | `gpt-4o-mini`               | Model id sent to the provider.                           |

All variables are read **only on the server** (inside the API route). None are prefixed with `NEXT_PUBLIC_`, so they are never bundled into client code. If `AI_API_KEY` is missing, the API returns a clear 503 error instead of crashing.

Provider examples:

| Provider   | `AI_BASE_URL`                  | Example `AI_MODEL`          |
| ---------- | ------------------------------ | ---------------------------- |
| OpenAI     | `https://api.openai.com/v1`    | `gpt-4o-mini`               |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini`        |
| Groq       | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| DeepSeek   | `https://api.deepseek.com/v1`  | `deepseek-chat`             |

## Production (Vercel)

1. Push this repository to GitHub.
2. In [Vercel](https://vercel.com), **Add New Project** → import the repo.
3. Framework preset: **Next.js** (auto-detected). Build command `next build`, output handled automatically — no custom configuration needed.
4. Add the environment variables (`AI_API_KEY`, optionally `AI_BASE_URL`, `AI_MODEL`) under **Settings → Environment Variables** for the Production (and Preview) environments.
5. Deploy.

The chat route runs on the Node.js runtime with a 60s max duration (set via `maxDuration` in `app/api/chat/route.ts`).

## Security notes (v0.1 baseline)

- API keys live only in server-side env vars; never sent to or readable by the browser.
- `POST /api/chat` strictly validates input (roles, types, sizes, non-empty last user message) and caps body size.
- Provider error bodies are never forwarded to the client — they are mapped to safe messages (no stack traces, no secrets).
- Assistant Markdown is rendered with `react-markdown` **without** raw-HTML support, so model/user-controlled content cannot inject HTML/scripts.
- The system prompt role is enforced server-side; clients can only submit `user`/`assistant` turns.
- No CORS headers are added, so the API defaults to same-origin usage.
- `.env*` files are git-ignored; `.env.example` contains no real credentials.
