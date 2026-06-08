"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, "") ||
  "http://localhost:8000";

// A wide pool of dispatch prompts — five are sampled fresh on every visit.
const QUESTION_POOL: string[] = [
  "What was Egypt's GDP growth in 2022?",
  "Top trading partners for Algeria in 2024",
  "Africa's inflation outlook for 2025",
  "Debt analysis for North African economies",
  "How has the Egyptian pound performed against the US dollar?",
  "Which African economies are most exposed to commodity shocks?",
  "Foreign direct investment trends in Sub-Saharan Africa",
  "Compare fiscal deficits across MENA countries",
  "What are the main drivers of inflation in Egypt?",
  "Renewable energy investment across North Africa",
  "Impact of the AfCFTA on intra-African trade",
  "Sovereign debt distress in low-income African countries",
  "Remittance flows to Egypt and the Maghreb",
  "Tourism revenue recovery in Egypt and Morocco",
  "Suez Canal revenue trends and outlook",
  "Youth unemployment in North Africa",
  "Monetary policy responses by the Central Bank of Egypt",
  "Egypt's external debt service burden in 2024",
  "Agricultural productivity across the Sahel",
  "IMF program outcomes for Egypt and Tunisia",
  "Energy subsidy reforms in Egypt",
  "Capital outflows from emerging African markets",
  "Effects of EU border policy on North African economies",
  "Inflation pass-through from currency devaluations",
  "Public-private partnership infrastructure in Africa",
  "Egypt's Vision 2030 progress indicators",
  "Climate-related fiscal risks in African economies",
  "Banking sector resilience in Egypt and Nigeria",
  "Wheat import dependency and food security in MENA",
  "Mining sector contributions to African GDP",
];

function sampleQuestions(pool: string[], n: number): string[] {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

type Source = {
  doc_name: string;
  page: number | null;
  snippet: string;
  reasoning?: string;
  full_text?: string;
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

/** Highlight inline [N] citation markers, render rest of the answer. */
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
        className="font-mono font-semibold text-oxblood mx-[0.1em] align-super text-[0.62em] tracking-wide"
      >
        [{m[1]}]
      </sup>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatToday(): { date: string; vol: string; issue: string } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const yearOpen = new Date(now.getFullYear(), 0, 1);
  const dayOfYear =
    Math.floor((now.getTime() - yearOpen.getTime()) / 86400000) + 1;
  // Vol. = years since founding of ECES (1992 — symbolic, only used as masthead flavor)
  const vol = String(now.getFullYear() - 1991);
  const issue = `№ ${pad2(dayOfYear)}`;
  return {
    date: fmt.format(now).toUpperCase(),
    vol: `VOL. ${vol}`,
    issue,
  };
}

function Monogram({ className = "" }: { className?: string }) {
  // E + bar-chart monogram, framed like a colophon.
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="1.5"
        y="1.5"
        width="61"
        height="61"
        rx="2"
        fill="none"
        stroke="#10162a"
        strokeWidth="1"
      />
      <rect
        x="5"
        y="5"
        width="54"
        height="54"
        rx="1"
        fill="none"
        stroke="#10162a"
        strokeWidth="0.6"
        opacity="0.5"
      />
      {/* Bars climbing right */}
      <rect x="16" y="40" width="6" height="14" fill="#7a1d2b" />
      <rect x="26" y="32" width="6" height="22" fill="#10162a" />
      <rect x="36" y="22" width="6" height="32" fill="#10162a" />
      <rect x="46" y="14" width="6" height="40" fill="#7a1d2b" />
      {/* Baseline rule */}
      <rect x="14" y="54" width="40" height="1" fill="#10162a" />
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
        strokeWidth="1.2"
      />
      <path d="M13 2.5V7a1 1 0 0 0 1 1h4.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function SendGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4 12h14M12 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
    </svg>
  );
}

function ArchiveGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="3.5" y="4.5" width="17" height="4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4.5 8.5h15v10.5a.5.5 0 0 1-.5.5h-14a.5.5 0 0 1-.5-.5V8.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9.5 12.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
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

  // Sample five fresh prompts per mount.
  const suggested = useMemo(() => sampleQuestions(QUESTION_POOL, 5), []);
  const masthead = useMemo(() => formatToday(), []);

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
    <main className="min-h-screen pb-44">
      {/* ─────── MASTHEAD ─────── */}
      <header className="pt-10 md:pt-14">
        <div className="mx-auto max-w-prose px-6">
          {/* Top metadata row */}
          <div className="flex items-center justify-between gap-4 mb-5 fade d-1">
            <span className="rubric text-ink/55">{masthead.vol}</span>
            <span className="rubric text-ink/55 hidden sm:inline">
              EST. MCMXCII · CAIRO
            </span>
            <span className="rubric text-ink/55">{masthead.issue}</span>
          </div>

          <div className="rule rule-anim d-2" />

          {/* Title row */}
          <div className="grid grid-cols-[auto_1fr_auto] items-end gap-4 md:gap-6 pt-6 pb-5">
            <div className="fade-up d-3 self-end">
              <Monogram className="w-14 h-14 md:w-[68px] md:h-[68px]" />
            </div>
            <div className="text-center">
              <h1 className="masthead text-[64px] md:text-[104px] text-ink fade-up d-4">
                EconBot
              </h1>
              <p className="rubric text-ink/60 mt-3 fade d-5">
                The <span className="text-oxblood">ECES</span> Dispatch
                <span className="diamond" />
                Research Instrument
              </p>
            </div>
            <div className="text-right self-end fade d-3">
              <p className="rubric text-ink/55 leading-snug">
                {masthead.date}
              </p>
            </div>
          </div>

          <div className="rule-double rule-anim-right d-6" />

          {/* Standfirst */}
          <p className="mt-6 max-w-column mx-auto text-center text-[15px] md:text-base text-ink/70 leading-relaxed fade-up d-7">
            <span className="smallcaps text-oxblood font-semibold mr-1.5">
              Cairo —
            </span>
            An archival research instrument of the{" "}
            <em className="headline-italic text-ink">
              Egyptian Centre for Economic Studies
            </em>
            , returning grounded analysis from African economic literature,
            indexed to the page.
          </p>
        </div>
      </header>

      {/* ─────── BODY ─────── */}
      <div className="mx-auto max-w-prose px-6 mt-14">
        {/* Collection selector — styled as a "filed under" line */}
        <section className="mb-12 fade-up d-8">
          <div className="flex items-baseline gap-3 mb-3">
            <span className="rubric text-ink/55">Filed Under</span>
            <span className="leader" aria-hidden />
            {!loadingCollections && !collectionsError && collections.length > 0 && (
              <span className="rubric text-ink/40">
                {pad2(collections.length)} collections
              </span>
            )}
          </div>
          {loadingCollections ? (
            <p className="font-serif italic text-ink/55">Loading collections…</p>
          ) : collectionsError ? (
            <div className="border border-rule bg-parchment/60 p-4">
              <p className="font-serif text-[15px] text-ink leading-relaxed">
                {collectionsError}
              </p>
              <p className="mt-2 rubric text-ink/55">
                Confirm the backend at{" "}
                <code className="font-mono text-oxblood normal-case tracking-normal">
                  {BACKEND}
                </code>
              </p>
            </div>
          ) : collections.length === 0 ? (
            <p className="font-serif italic text-ink/65">
              No collections were found in the Qdrant cluster.
            </p>
          ) : (
            <div className="relative">
              <select
                id="collection"
                className="ec-select w-full bg-transparent border-0 border-b border-ink/30 focus:border-oxblood focus:outline-none font-display text-xl md:text-2xl text-ink py-2 transition-colors"
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
              >
                {collections.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>

        {/* ─────── EMPTY STATE / DISPATCHES ─────── */}
        <section className="space-y-10">
          {history.length === 0 && !pending && (
            <div className="fade-up d-9">
              <div className="flex items-baseline gap-4 mb-5">
                <span className="rubric text-oxblood">Today's Dispatches</span>
                <span className="leader" aria-hidden />
                <span className="rubric text-ink/40">A Fresh Selection</span>
              </div>

              <p className="font-serif italic text-ink/65 text-[15px] mb-2 leading-relaxed">
                A rotating selection of inquiries, drawn from the archive's
                research vein. Begin with one of these — or compose your own
                below.
              </p>

              <ol className="mt-4">
                {suggested.map((q, idx) => (
                  <li key={q} className="fade-up" style={{ animationDelay: `${0.95 + idx * 0.08}s` }}>
                    <button
                      type="button"
                      onClick={() => {
                        setInput(q);
                        inputRef.current?.focus();
                      }}
                      className="dispatch group w-full"
                    >
                      <span className="font-mono text-oxblood text-[11px] tracking-wider pt-1">
                        {pad2(idx + 1)}
                      </span>
                      <span className="font-display text-[19px] md:text-[22px] text-ink leading-snug group-hover:text-oxblood transition-colors">
                        {q}
                      </span>
                      <span className="arrow font-mono text-base pt-1">→</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* ─────── HISTORY ENTRIES ─────── */}
          {history.map((entry, i) => (
            <article
              key={i}
              className="card-enter relative"
            >
              {/* Entry header — number + question as a banner */}
              <div className="flex items-baseline gap-3 mb-4">
                <span className="rubric text-oxblood">
                  Dispatch № {pad2(i + 1)}
                </span>
                <span className="leader" aria-hidden />
                <span className="rubric text-ink/40">
                  {(entry.latency_ms / 1000).toFixed(2)}s
                  {entry.sources.length > 0
                    ? ` · ${pad2(entry.sources.length)} cited`
                    : ""}
                </span>
              </div>

              <h2 className="font-display italic text-[28px] md:text-[34px] text-ink leading-[1.1] mb-7 max-w-[34ch]">
                {entry.question}
              </h2>

              <div className="rule-soft mb-7" />

              {/* Answer body with drop cap */}
              <div className="font-serif text-ink text-[17.5px] md:text-[18.5px] leading-[1.72] dropcap whitespace-pre-wrap">
                {renderAnswerBody(entry.answer)}
              </div>

              {/* Sources — library catalogue */}
              {entry.sources.length > 0 && (
                <section className="mt-12">
                  <div className="flex items-baseline gap-3 mb-6">
                    <span className="rubric text-ink/55">Bibliography</span>
                    <span className="leader" aria-hidden />
                    <span className="rubric text-ink/40">
                      {pad2(entry.sources.length)} Entries
                    </span>
                  </div>

                  <ol className="space-y-0">
                    {entry.sources.map((s, j) => (
                      <li
                        key={j}
                        className="catalog-entry border-t border-rule-soft last:border-b last:border-rule-soft pl-5 pr-3 py-5"
                      >
                        {/* Catalog header row */}
                        <div className="flex items-baseline gap-3 mb-3">
                          <span className="font-mono text-oxblood text-[12px] font-semibold tracking-wider">
                            [{pad2(j + 1)}]
                          </span>
                          <PdfIcon className="w-3.5 h-3.5 text-ink/55 self-center" />
                          <span className="leader" aria-hidden />
                          {s.page != null && (
                            <span className="font-mono text-[11px] text-ink/55 tracking-wider uppercase">
                              Folio · p. {s.page}
                            </span>
                          )}
                        </div>

                        {/* Document title */}
                        <p className="font-display text-[20px] md:text-[22px] text-ink leading-snug mb-3 max-w-[44ch]">
                          {s.doc_name}
                        </p>

                        {/* Snippet — pulled quote */}
                        {s.snippet && (
                          <div className="mt-3 mb-4 ml-1">
                            <p className="pull-quote font-serif italic text-[15.5px] md:text-[16px] text-ink/85 leading-[1.65] max-w-[58ch]">
                              {s.snippet}
                              <span className="text-oxblood/60 not-italic">
                                {" ”"}
                              </span>
                            </p>
                          </div>
                        )}

                        {/* Reasoning — annotation column */}
                        {s.reasoning && (
                          <div className="mt-3 ml-1 border-l-2 border-rule pl-4 py-1 max-w-[58ch]">
                            <p className="rubric text-ink/55 mb-1.5">
                              Curator's Note
                            </p>
                            <p className="font-serif text-[14px] text-ink/75 leading-[1.65]">
                              {s.reasoning}
                            </p>
                          </div>
                        )}

                        {/* Archive disclosure */}
                        {s.full_text && (
                          <details className="mt-4 ml-1 group">
                            <summary className="cursor-pointer inline-flex items-center gap-2 font-mono text-[11px] text-ink/60 hover:text-oxblood transition-colors select-none uppercase tracking-wider">
                              <ArchiveGlyph className="w-3.5 h-3.5" />
                              <span className="group-open:hidden">Open archive</span>
                              <span className="hidden group-open:inline">
                                Close archive
                              </span>
                            </summary>
                            <div className="mt-3 border-l-2 border-oxblood/40 bg-parchment/55 px-4 py-3 max-h-80 overflow-y-auto">
                              <p className="font-serif text-[14px] text-ink/85 leading-[1.7] whitespace-pre-wrap">
                                {s.full_text}
                              </p>
                            </div>
                          </details>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {/* Entry close-mark */}
              <div className="mt-10 flex items-center justify-center gap-3 text-ink/30">
                <span className="h-px bg-current w-12" />
                <span className="font-mono text-[10px] tracking-[0.4em] uppercase">
                  End of Dispatch
                </span>
                <span className="h-px bg-current w-12" />
              </div>
            </article>
          ))}

          {/* ─────── PENDING ─────── */}
          {pending && (
            <div
              aria-live="polite"
              className="card-enter pt-6"
            >
              <div className="flex items-baseline gap-3 mb-3">
                <span className="rubric text-oxblood ec-blink">
                  Composing
                </span>
                <span className="leader" aria-hidden />
                <span className="rubric text-ink/40">Stand by</span>
              </div>
              <p className="font-display italic text-[22px] md:text-[26px] text-ink/55 leading-snug">
                Consulting the archive
                <span className="ec-pulse inline-block ml-2 w-2 h-2 rounded-full bg-oxblood align-middle" />
              </p>
            </div>
          )}

          {/* ─────── ERROR ─────── */}
          {error && (
            <div
              role="alert"
              className="border-l-2 border-oxblood bg-parchment/70 px-5 py-4"
            >
              <p className="rubric text-oxblood mb-1">Errata</p>
              <p className="font-serif text-[15px] text-ink leading-relaxed">
                {error}
              </p>
            </div>
          )}

          <div ref={chatEndRef} />
        </section>
      </div>

      {/* ─────── COMPOSER ─────── */}
      <div className="fixed bottom-0 left-0 right-0 composer-surface border-t border-rule">
        <div className="mx-auto max-w-prose px-6 py-5">
          <div className="flex items-baseline gap-3 mb-2.5">
            <span className="rubric text-ink/55">Compose</span>
            <span className="leader" aria-hidden />
            <span className="rubric text-ink/35">
              Enter to file · Shift+Enter for newline
            </span>
          </div>
          <form onSubmit={onSubmit} className="flex items-end gap-3">
            <div className="flex-1 border-b-2 border-ink/30 focus-within:border-oxblood transition-colors">
              <textarea
                ref={inputRef}
                rows={1}
                aria-label="Question"
                placeholder="Pose a research question for the archive…"
                className="w-full bg-transparent resize-none px-1 py-2.5 text-ink placeholder:text-ink/35 placeholder:italic focus:outline-none font-display text-[19px] md:text-[21px] leading-snug max-h-[200px]"
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
              aria-label="File question"
              className="group inline-flex items-center gap-2.5 bg-ink px-5 py-3 text-parchment font-mono text-[11px] uppercase tracking-[0.22em] transition-all hover:bg-oxblood disabled:cursor-not-allowed disabled:bg-ink/30"
              disabled={
                pending ||
                loadingCollections ||
                !collection ||
                input.trim().length === 0
              }
            >
              {pending ? (
                <span>Filing…</span>
              ) : (
                <>
                  <span>File</span>
                  <SendGlyph className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </>
              )}
            </button>
          </form>
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
