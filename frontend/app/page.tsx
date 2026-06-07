"use client";

import { useEffect, useRef, useState } from "react";

const BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, "") ||
  "http://localhost:8000";

const EXAMPLE_QUESTIONS = [
  "What was Egypt's GDP growth in 2022?",
  "Top trading partners for Algeria in 2024",
  "Africa's inflation outlook for 2025",
  "Debt analysis for North African economies",
];

type Source = {
  doc_name: string;
  page: number | null;
  snippet: string;
};

type QueryResponse = {
  answer: string;
  sources: Source[];
  latency_ms: number;
};

type Entry = {
  question: string;
  answer: string;
  sources: Source[];
  latency_ms: number;
};

/** Render the answer body and highlight inline [N] citation markers. */
function renderAnswerBody(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /\[(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <sup
        key={`c-${i++}`}
        className="font-serif font-semibold text-gold mx-0.5 align-super text-[0.78em]"
      >
        [{m[1]}]
      </sup>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function Logo({ className = "" }: { className?: string }) {
  // Minimal bar-chart monogram in navy + gold — institutional, economics-themed.
  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="1" y="1" width="38" height="38" rx="8" fill="#1e3a5f" />
      <rect x="1" y="1" width="38" height="38" rx="8" fill="url(#shine)" opacity="0.18" />
      <defs>
        <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="10" y="22" width="4.5" height="10" rx="1" fill="#c8a85a" />
      <rect x="17.75" y="16" width="4.5" height="16" rx="1" fill="#c8a85a" />
      <rect x="25.5" y="10" width="4.5" height="22" rx="1" fill="#c8a85a" />
    </svg>
  );
}

function PdfIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M6 2.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M13 2.5V7a1 1 0 0 0 1 1h4.5" stroke="currentColor" strokeWidth="1.4" />
      <text
        x="12"
        y="17.5"
        textAnchor="middle"
        fontSize="5.5"
        fontWeight="700"
        fill="currentColor"
        fontFamily="system-ui, sans-serif"
      >
        PDF
      </text>
    </svg>
  );
}

function SendIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3.5 11.5 20 4l-3.5 16.5L11 13l-7.5-1.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M11 13l4-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function DatabaseIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <ellipse cx="12" cy="5" rx="7.5" ry="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4.5 5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V5M4.5 11v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export default function Page() {
  const [collections, setCollections] = useState<string[]>([]);
  const [collection, setCollection] = useState<string>("");
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [loadingCollections, setLoadingCollections] = useState(true);

  const [history, setHistory] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${BACKEND}/collections`);
        if (!res.ok) {
          const detail = await safeDetail(res);
          throw new Error(detail || `Backend returned ${res.status}`);
        }
        const data = (await res.json()) as { collections: string[] };
        if (cancelled) return;
        setCollections(data.collections);
        if (data.collections.length > 0) {
          const preferred = data.collections.find(
            (c) => c === "economic_doc_openai",
          );
          setCollection(preferred ?? data.collections[0]);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setCollectionsError(
          `Could not reach the backend at ${BACKEND}. ${message}`,
        );
      } finally {
        if (!cancelled) setLoadingCollections(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, pending]);

  async function runQuery(question: string) {
    const q = question.trim();
    if (!q || pending) return;
    if (!collection) {
      setError("Select a collection before asking a question.");
      return;
    }
    setError(null);
    setPending(true);
    setInput("");
    try {
      const res = await fetch(`${BACKEND}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection, question: q }),
      });
      if (!res.ok) {
        const detail = await safeDetail(res);
        throw new Error(detail || `Backend returned ${res.status}`);
      }
      const data = (await res.json()) as QueryResponse;
      setHistory((h) => [
        ...h,
        {
          question: q,
          answer: data.answer,
          sources: data.sources,
          latency_ms: data.latency_ms,
        },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setPending(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await runQuery(input);
  }

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runQuery(input);
    }
  }

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  return (
    <main className="min-h-screen pb-40">
      {/* Header */}
      <header className="border-b border-gold/20 bg-parchment/40">
        <div className="mx-auto max-w-prose px-6 py-8 flex items-center gap-4">
          <Logo className="w-12 h-12 shrink-0 drop-shadow-sm" />
          <div className="flex-1">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h1 className="font-serif text-4xl md:text-5xl text-navy leading-none tracking-tight">
                EconBot
              </h1>
              <span className="font-sans text-[10px] uppercase tracking-[0.22em] text-gold font-semibold">
                by ECES
              </span>
            </div>
            <p className="mt-2 text-sm md:text-[15px] text-ink/65 font-sans">
              Egyptian Centre for Economic Studies — African Economic Research
              Assistant
            </p>
          </div>
        </div>
        <div className="h-[2px] bg-gradient-to-r from-transparent via-gold/40 to-transparent" />
      </header>

      <div className="mx-auto max-w-prose px-6 pt-8">
        {/* Collection selector */}
        <section className="mb-8 rounded-xl border border-navy/10 bg-white/70 shadow-[0_1px_2px_rgba(30,58,95,0.04)] p-5">
          <div className="flex items-center gap-2 mb-3">
            <DatabaseIcon className="w-4 h-4 text-navy/70" />
            <label
              htmlFor="collection"
              className="font-serif text-base text-navy"
            >
              Collection
            </label>
            {!loadingCollections && !collectionsError && collections.length > 0 && (
              <span className="ml-auto text-[11px] uppercase tracking-wider text-ink/45">
                {collections.length} available
              </span>
            )}
          </div>
          {loadingCollections ? (
            <p className="text-sm text-ink/60 italic">Loading collections…</p>
          ) : collectionsError ? (
            <div className="rounded border border-navy/20 bg-parchment p-3">
              <p className="text-sm text-ink">{collectionsError}</p>
              <p className="mt-2 text-xs text-ink/60">
                Confirm the backend is running and reachable at{" "}
                <code className="text-navy">{BACKEND}</code>.
              </p>
            </div>
          ) : collections.length === 0 ? (
            <p className="text-sm text-ink/70">
              No collections were found in the Qdrant cluster.
            </p>
          ) : (
            <>
              <select
                id="collection"
                className="econbot-select w-full rounded-md border border-navy/25 bg-white px-3 py-2.5 text-ink font-sans focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/35 transition-colors"
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
              >
                {collections.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-ink/55">
                Queries run against the currently selected collection.
              </p>
            </>
          )}
        </section>

        {/* Chat / empty state */}
        <section className="space-y-8">
          {history.length === 0 && !pending && (
            <div className="rounded-xl border border-dashed border-navy/15 bg-white/40 p-7">
              <h2 className="font-serif text-2xl text-navy mb-1">
                Ask a research question
              </h2>
              <p className="text-sm text-ink/65 mb-5">
                EconBot retrieves grounded answers from African economic
                reports — with citations to the exact PDF and page.
              </p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => {
                      setInput(q);
                      inputRef.current?.focus();
                    }}
                    className="text-left text-xs md:text-sm rounded-full border border-navy/20 bg-white text-navy/85 px-3.5 py-1.5 hover:bg-navy hover:text-parchment hover:border-navy transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {history.map((entry, i) => (
            <article
              key={i}
              className="econbot-card-enter rounded-xl border border-navy/10 bg-white/80 p-6 shadow-[0_2px_8px_rgba(30,58,95,0.05)]"
            >
              <div className="border-l-[3px] border-gold pl-4 mb-5">
                <p className="font-serif italic text-lg md:text-xl text-navy leading-snug">
                  {entry.question}
                </p>
              </div>

              <div className="text-ink text-[15px] leading-[1.75] whitespace-pre-wrap font-sans">
                {renderAnswerBody(entry.answer)}
              </div>

              {entry.sources.length > 0 && (
                <section className="mt-6 pt-5 border-t border-gold/20">
                  <p className="font-serif text-[11px] uppercase tracking-[0.22em] text-navy/65 mb-4">
                    Sources
                  </p>
                  <ol className="space-y-2.5">
                    {entry.sources.map((s, j) => (
                      <li
                        key={j}
                        className="flex items-start gap-3 rounded-lg border border-navy/10 bg-parchment/60 px-3.5 py-2.5"
                      >
                        <span className="font-serif font-bold text-gold text-sm leading-none mt-1.5 w-5 shrink-0">
                          [{j + 1}]
                        </span>
                        <PdfIcon className="w-4 h-4 text-navy/55 mt-1 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm leading-snug">
                            <span className="font-serif italic text-navy">
                              {s.doc_name}
                            </span>
                            {s.page != null && (
                              <span className="text-ink/75">
                                {" "}
                                · page {s.page}
                              </span>
                            )}
                          </p>
                          {s.snippet && (
                            <details className="mt-1 group">
                              <summary className="cursor-pointer text-[10.5px] uppercase tracking-[0.18em] text-ink/40 hover:text-navy/75 transition-colors select-none">
                                quoted excerpt
                              </summary>
                              <p className="mt-1.5 text-xs italic text-ink/70 leading-relaxed">
                                &ldquo;{s.snippet}&rdquo;
                              </p>
                            </details>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <footer className="mt-5">
                <span className="text-[11px] uppercase tracking-wider text-ink/40">
                  {(entry.latency_ms / 1000).toFixed(2)} s
                  {entry.sources.length > 0
                    ? ` · ${entry.sources.length} cited source${
                        entry.sources.length === 1 ? "" : "s"
                      }`
                    : ""}
                </span>
              </footer>
            </article>
          ))}

          {pending && (
            <div
              aria-live="polite"
              className="econbot-card-enter rounded-xl border border-navy/10 bg-white/60 p-5 flex items-center gap-3"
            >
              <span className="econbot-pulse inline-block w-1.5 h-1.5 rounded-full bg-gold" />
              <span className="text-sm italic text-ink/55 econbot-pulse">
                Thinking…
              </span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-navy/30 bg-parchment p-4"
            >
              <p className="text-sm text-ink">
                <span className="font-serif font-semibold text-navy">
                  Something went wrong.
                </span>{" "}
                {error}
              </p>
            </div>
          )}

          <div ref={chatEndRef} />
        </section>
      </div>

      {/* Sticky composer */}
      <div className="fixed bottom-0 left-0 right-0 econbot-composer-blur border-t border-gold/20">
        <div className="mx-auto max-w-prose px-6 py-4">
          <form onSubmit={onSubmit} className="flex items-end gap-3">
            <div className="flex-1 rounded-xl border border-navy/25 bg-white focus-within:border-gold focus-within:ring-2 focus-within:ring-gold/30 transition-colors">
              <textarea
                ref={inputRef}
                rows={1}
                aria-label="Question"
                placeholder="Ask EconBot about African economic research…"
                className="w-full bg-transparent resize-none px-4 py-3 text-ink placeholder:text-ink/35 focus:outline-none font-sans text-[15px] leading-snug max-h-[200px]"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  autosize(e.currentTarget);
                }}
                onKeyDown={onTextareaKeyDown}
                disabled={pending || loadingCollections}
              />
            </div>
            <button
              type="submit"
              aria-label="Ask"
              className="inline-flex items-center gap-2 rounded-xl bg-navy px-5 py-3 text-sm font-medium text-parchment transition-all hover:bg-gold hover:text-navy hover:shadow-md disabled:cursor-not-allowed disabled:bg-navy/40 disabled:hover:bg-navy/40 disabled:hover:text-parchment disabled:hover:shadow-none"
              disabled={
                pending ||
                loadingCollections ||
                !collection ||
                input.trim().length === 0
              }
            >
              {pending ? (
                <span>Working…</span>
              ) : (
                <>
                  <span>Ask</span>
                  <SendIcon className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
          <p className="mt-2 text-[10.5px] uppercase tracking-[0.18em] text-ink/35">
            Enter to send · Shift+Enter for newline
          </p>
        </div>
      </div>
    </main>
  );
}

async function safeDetail(res: Response): Promise<string | null> {
  try {
    const data = await res.json();
    if (data && typeof data.detail === "string") return data.detail;
    if (data && data.detail) return JSON.stringify(data.detail);
    return null;
  } catch {
    return null;
  }
}
