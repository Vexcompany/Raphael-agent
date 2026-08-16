"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Role = "user" | "assistant";

interface Message {
  role: Role;
  content: string;
}

type ModelAvailability = "active" | "out_of_stock";

interface ModelInfo {
  id: string;
  displayName: string;
  availability: ModelAvailability;
  group: string;
}

const STORAGE_KEY = "raphael:conversation:v1";
const MODEL_STORAGE_KEY = "raphael:model:v1";
const STREAM_ERROR_MARKER = "[RAPHAEL_STREAM_ERROR]";
const MODEL_UNAVAILABLE_MARKER = "[RAPHAEL_MODEL_UNAVAILABLE]";
const DEFAULT_MODEL = "auto";

const GROUP_ORDER = [
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
];

function loadStoredMessages(): Message[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is Message =>
        typeof m === "object" &&
        m !== null &&
        ((m as Message).role === "user" || (m as Message).role === "assistant") &&
        typeof (m as Message).content === "string"
    );
  } catch {
    return [];
  }
}

function loadStoredModel(): string | null {
  try {
    const raw = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function isModelInfo(v: unknown): v is ModelInfo {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ModelInfo).id === "string" &&
    typeof (v as ModelInfo).displayName === "string" &&
    ((v as ModelInfo).availability === "active" ||
      (v as ModelInfo).availability === "out_of_stock") &&
    typeof (v as ModelInfo).group === "string"
  );
}

interface ModelGroup {
  group: string;
  models: ModelInfo[];
}

function groupModels(models: ModelInfo[]): ModelGroup[] {
  const map = new Map<string, ModelInfo[]>();
  for (const g of GROUP_ORDER) map.set(g, []);
  for (const m of models) {
    if (!map.has(m.group)) map.set(m.group, []);
    map.get(m.group)!.push(m);
  }
  return GROUP_ORDER.filter((g) => (map.get(g)?.length ?? 0) > 0).map((g) => ({
    group: g,
    models: map.get(g)!,
  }));
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Model selector state.
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsSource, setModelsSource] = useState<"ryzumi" | "fallback" | null>(null);
  const [modelsRefreshedAt, setModelsRefreshedAt] = useState<number | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [modelNotice, setModelNotice] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastUserMessageRef = useRef<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedModelRef = useRef<string>(DEFAULT_MODEL);

  // Keep a plain ref in sync so async callbacks (refreshModels) can read the
  // latest selection without stale-closure issues.
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  // Restore the current conversation and model selection after a refresh.
  // This must happen post-mount (localStorage does not exist during SSR), so
  // a synchronous setState in this one effect is intentional.
  const refreshModels = useCallback(async (force: boolean) => {
    setModelsRefreshing(true);
    try {
      const res = await fetch(`/api/models${force ? "?refresh=1" : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (typeof data !== "object" || data === null) return;
      const d = data as { models?: unknown; source?: unknown; refreshedAt?: unknown };
      if (Array.isArray(d.models)) {
        const list = d.models.filter(isModelInfo);
        setModels(list);

        // Keep the selection valid against the latest availability: if the
        // selected model is missing or out of stock, fall back to Auto.
        const prev = selectedModelRef.current;
        const sel = list.find((m) => m.id === prev);
        if (!sel || sel.availability === "out_of_stock") {
          const label = sel ? `"${sel.displayName}"` : `"${prev}"`;
          setModelNotice(`${label} is currently out of stock. Switched to Auto.`);
          setSelectedModel(DEFAULT_MODEL);
          selectedModelRef.current = DEFAULT_MODEL;
        }
      }
      if (d.source === "ryzumi" || d.source === "fallback") {
        setModelsSource(d.source);
      }
      if (typeof d.refreshedAt === "number") {
        setModelsRefreshedAt(d.refreshedAt);
      }
    } catch {
      /* keep the last known list */
    } finally {
      setModelsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const restored = loadStoredModel() ?? DEFAULT_MODEL;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages(loadStoredMessages());
    setSelectedModel(restored);
    selectedModelRef.current = restored;
    setHydrated(true);
    void refreshModels(false);
  }, [refreshModels]);

  // Persist conversation.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* storage full or unavailable — non-fatal */
    }
  }, [messages, hydrated]);

  // Persist the selected model so it survives a page reload.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    } catch {
      /* non-fatal */
    }
  }, [selectedModel, hydrated]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  // Auto-grow the textarea.
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  useEffect(resizeTextarea, [input, resizeTextarea]);

  // Close the model dropdown when clicking outside of it.
  useEffect(() => {
    if (!selectorOpen) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setSelectorOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selectorOpen]);

  const busy = isLoading || isStreaming;

  const selectedLabel = (() => {
    const sel = models.find((m) => m.id === selectedModel);
    if (sel) return sel.displayName;
    return selectedModel === DEFAULT_MODEL ? "Auto" : selectedModel;
  })();

  const sendConversation = useCallback(
    async (history: Message[]) => {
      setError(null);
      setIsLoading(true);

      // Defensive: never send with a model the latest availability says is
      // unavailable. The server enforces this too.
      if (models.length > 0) {
        const sel = models.find((m) => m.id === selectedModel);
        if (!sel || sel.availability === "out_of_stock") {
          setError(
            `The model "${sel?.displayName ?? selectedModel}" is currently unavailable. Please choose another model.`
          );
          setIsLoading(false);
          return;
        }
      }

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history, model: selectedModel }),
          signal: controller.signal,
        });

        if (!res.ok) {
          let msg = `Request failed (status ${res.status}).`;
          try {
            const data: unknown = await res.json();
            if (
              typeof data === "object" &&
              data !== null &&
              typeof (data as { error?: unknown }).error === "string"
            ) {
              msg = (data as { error: string }).error;
            }
          } catch {
            /* non-JSON error body */
          }
          throw new Error(msg);
        }

        if (!res.body) {
          throw new Error("The server returned an empty response.");
        }

        // Stream the assistant reply into a new message.
        setIsLoading(false);
        setIsStreaming(true);
        setActiveTools([]);
        setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = "";
        let failedModel: string | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          full += decoder.decode(value, { stream: true });

          // Tool-activity lines are surfaced as a muted note, never rendered
          // as markdown. Markers are small and emitted atomically.
          const toolNames: string[] = [];
          const toolRe = /\[RAPHAEL_TOOL\](\{[^}]*\})\n/g;
          let toolMatch: RegExpExecArray | null;
          toolRe.lastIndex = 0;
          while ((toolMatch = toolRe.exec(full)) !== null) {
            try {
              const parsed = JSON.parse(toolMatch[1]) as { name?: unknown };
              if (typeof parsed.name === "string" && parsed.name) {
                toolNames.push(parsed.name);
              }
            } catch {
              /* malformed activity line — skip */
            }
          }
          if (toolNames.length > 0) setActiveTools(toolNames);

          let visible = full.replace(toolRe, "");
          let streamError: string | null = null;

          const mIdx = visible.indexOf(MODEL_UNAVAILABLE_MARKER);
          if (mIdx !== -1) {
            const after = visible.slice(mIdx + MODEL_UNAVAILABLE_MARKER.length);
            const nl = after.indexOf("\n");
            failedModel = (nl === -1 ? after : after.slice(0, nl)).trim();
            streamError = (
              nl === -1
                ? "The selected model is currently unavailable."
                : after.slice(nl + 1)
            ).trim();
            visible = visible.slice(0, mIdx).trimEnd();
          } else {
            const idx = visible.indexOf(STREAM_ERROR_MARKER);
            if (idx !== -1) {
              visible = visible.slice(0, idx).trimEnd();
              streamError = visible.slice(idx + STREAM_ERROR_MARKER.length).trim();
            }
          }

          setMessages((prev) => {
            const next = [...prev];
            next[next.length - 1] = { role: "assistant", content: visible };
            return next;
          });

          if (streamError) {
            setError(streamError);
            break;
          }
        }

        // If the stream produced no visible text and errored, drop the
        // empty assistant bubble.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.content.trim() === "") {
            return prev.slice(0, -1);
          }
          return prev;
        });

        // The chosen model disappeared mid-stream. Refresh availability so
        // it gets disabled; the effect above then falls back to Auto.
        if (failedModel) {
          void refreshModels(false);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return; // user started a new chat / navigated away
        }
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Something went wrong. Please check your connection and try again.";
        setError(msg);
      } finally {
        setIsLoading(false);
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [selectedModel, models, refreshModels]
  );

  const handleSelectModel = useCallback((id: string) => {
    setSelectedModel(id);
    selectedModelRef.current = id;
    setSelectorOpen(false);
    setError(null);
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    lastUserMessageRef.current = text;
    setInput("");

    const userMessage: Message = { role: "user", content: text };
    const history = [...messages, userMessage];
    setMessages(history);
    await sendConversation(history);
  }, [input, busy, messages, sendConversation]);

  const handleRetry = useCallback(async () => {
    if (busy) return;
    // Re-send the conversation ending at the last user message.
    let history = [...messages];
    while (history.length > 0 && history[history.length - 1].role !== "user") {
      history = history.slice(0, -1);
    }
    if (history.length === 0) {
      setError(null);
      return;
    }
    setMessages(history);
    await sendConversation(history);
  }, [busy, messages, sendConversation]);

  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    setError(null);
    setModelNotice(null);
    setActiveTools([]);
    setIsLoading(false);
    setIsStreaming(false);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    textareaRef.current?.focus();
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void handleSend();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hasMessages = messages.length > 0;
  const grouped = groupModels(models);
  const updatedLabel = modelsRefreshedAt
    ? new Date(modelsRefreshedAt).toLocaleTimeString()
    : "…";

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>Raphael</h1>
          <span>v0.1 · AI agent in development</span>
        </div>

        <div className="headerRight">
          <div className="modelPicker" ref={pickerRef}>
            <span className="modelPickerLabel">Model</span>
            <button
              type="button"
              className="modelPickerBtn"
              onClick={() => setSelectorOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={selectorOpen}
              title={selectedLabel}
            >
              <span className="modelPickerName">{selectedLabel}</span>
              <svg
                className="modelCaret"
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {selectorOpen && (
              <div className="modelDropdown" role="listbox" aria-label="Models">
                <div className="modelDropdownTop">
                  <span className="modelDropdownTitle">Models</span>
                  <button
                    type="button"
                    className="modelRefreshBtn"
                    onClick={() => void refreshModels(true)}
                    disabled={modelsRefreshing}
                  >
                    {modelsRefreshing ? "Refreshing…" : "Refresh"}
                  </button>
                </div>

                {grouped.map((g) => (
                  <div key={g.group} className="modelGroup">
                    <div className="modelGroupLabel">{g.group}</div>
                    {g.models.map((m) => {
                      const active = m.availability === "active";
                      const isSelected = selectedModel === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={`modelRow ${active ? "" : "modelRowDisabled"} ${
                            isSelected ? "modelRowSelected" : ""
                          }`}
                          onClick={() => active && handleSelectModel(m.id)}
                          disabled={!active}
                        >
                          <span
                            className={`modelDot ${
                              active ? "modelDotActive" : "modelDotOut"
                            }`}
                          />
                          <span className="modelRowName">{m.displayName}</span>
                          <span
                            className={`modelStatus ${
                              active ? "modelStatusActive" : "modelStatusOut"
                            }`}
                          >
                            {active ? "ACTIVE" : "OUT OF STOCK"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}

                <div className="modelDropdownFoot">
                  <span>
                    Updated {updatedLabel} ·{" "}
                    {modelsSource === "ryzumi"
                      ? "live from Ryzumi"
                      : "offline catalog"}
                  </span>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            className="newChatBtn"
            onClick={handleNewChat}
            disabled={!hasMessages && !busy}
          >
            New chat
          </button>
        </div>
      </header>

      {modelNotice && (
        <div className="modelNotice" role="status">
          <span>{modelNotice}</span>
          <button
            type="button"
            className="modelNoticeBtn"
            onClick={() => setModelNotice(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {hasMessages ? (
        <main className="messages" aria-live="polite">
          <div className="messagesInner">
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <span className="msgLabel">
                  {m.role === "user" ? "You" : "Raphael"}
                </span>
                <div className="msgBody">
                  {m.role === "assistant" ? (
                    m.content ? (
                      <>
                        {i === messages.length - 1 && activeTools.length > 0 && (
                          <div className="toolNote">
                            Ran: {activeTools.join(" · ")}
                          </div>
                        )}
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {m.content}
                        </ReactMarkdown>
                      </>
                    ) : (
                      <div className="typing" aria-label="Raphael is typing">
                        <span /><span /><span />
                      </div>
                    )
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="msg assistant">
                <span className="msgLabel">Raphael</span>
                <div className="msgBody">
                  <div className="typing" aria-label="Raphael is thinking">
                    <span /><span /><span />
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="errorBanner" role="alert">
                <span>{error}</span>
                <button type="button" className="retryBtn" onClick={handleRetry}>
                  Retry
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </main>
      ) : (
        <main className="empty">
          <div className="emptyMark">R</div>
          <h2>Raphael</h2>
          <p>
            A general-purpose AI agent under development. Right now I can chat —
            ask me anything, from explanations to writing to code.
          </p>
          {error && (
            <div className="errorBanner" role="alert">
              <span>{error}</span>
              <button type="button" className="retryBtn" onClick={handleRetry}>
                Dismiss
              </button>
            </div>
          )}
        </main>
      )}

      <div className="composerWrap">
        <form className="composer" onSubmit={onSubmit}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Raphael…"
            rows={1}
            disabled={false}
            aria-label="Message Raphael"
          />
          <button
            type="submit"
            className="sendBtn"
            disabled={busy || input.trim().length === 0}
            aria-label="Send message"
            title="Send"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        </form>
        <p className="hint">Enter to send · Shift+Enter for a new line</p>
      </div>
    </div>
  );
}
