"""EconBot backend — local FastAPI service for the ECES RAG app.

Pipeline per /query:
    embed query (OpenAI text-embedding-3-small)
        -> hybrid retrieve in Qdrant (dense + bm25, RRF fusion server-side)
        -> Cohere rerank-english-v3.0 to top 10
        -> grounded answer from OpenAI gpt-4o-mini with (doc, page) citations
"""

from __future__ import annotations

import logging
import os
import re
import time
import traceback
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Load .env from the backend/ directory before reading any env vars.
load_dotenv()

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
QDRANT_URL = os.getenv("QDRANT_URL", "").strip()
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", "").strip()
COHERE_API_KEY = os.getenv("COHERE_API_KEY", "").strip()

EMBED_MODEL = "text-embedding-3-small"
GEN_MODEL = "gpt-4o-mini"
RERANK_MODEL = "rerank-english-v3.0"

# Retrieval knobs
PREFETCH_LIMIT = 20      # per-vector prefetch limit before RRF
CANDIDATES = 30          # fused candidates fed to reranker
TOP_K = 10               # reranked chunks passed to the generator
RERANK_CHAR_CAP = 2000   # truncate each chunk before sending to Cohere

# Comma-separated origins from env, defaulting to localhost for local dev.
# When deployed, set ALLOWED_ORIGINS to the deployed frontend URL, e.g.
#   ALLOWED_ORIGINS=https://eces-rag-system-frontend.onrender.com
_raw_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
CORS_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("econbot")


def _require(name: str, value: str) -> None:
    if not value:
        raise RuntimeError(
            f"Missing required environment variable: {name}. "
            "Copy backend/.env.example to backend/.env and fill in the keys."
        )


def _check_settings() -> None:
    _require("OPENAI_API_KEY", OPENAI_API_KEY)
    _require("QDRANT_URL", QDRANT_URL)
    _require("QDRANT_API_KEY", QDRANT_API_KEY)
    _require("COHERE_API_KEY", COHERE_API_KEY)


# ---------------------------------------------------------------------------
# Lazy clients — built on first use so the backend boots fast
# ---------------------------------------------------------------------------

_qdrant = None
_openai = None
_cohere = None


def get_qdrant():
    global _qdrant
    if _qdrant is None:
        from qdrant_client import QdrantClient
        _check_settings()
        _qdrant = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY, timeout=60.0)
    return _qdrant


def get_openai():
    global _openai
    if _openai is None:
        from openai import OpenAI
        _check_settings()
        _openai = OpenAI(api_key=OPENAI_API_KEY)
    return _openai


def get_cohere():
    global _cohere
    if _cohere is None:
        import cohere
        _check_settings()
        _cohere = cohere.ClientV2(api_key=COHERE_API_KEY)
    return _cohere


# ---------------------------------------------------------------------------
# API models
# ---------------------------------------------------------------------------


class QueryRequest(BaseModel):
    collection: str = Field(..., min_length=1)
    question: str = Field(..., min_length=1)


class SourceItem(BaseModel):
    doc_name: str
    page: int | None = None
    snippet: str
    reasoning: str = ""
    full_text: str = ""


class QueryResponse(BaseModel):
    answer: str
    sources: list[SourceItem]
    latency_ms: int


class CollectionsResponse(BaseModel):
    collections: list[str]


# ---------------------------------------------------------------------------
# Core pipeline
# ---------------------------------------------------------------------------


def embed_query(text: str) -> list[float]:
    client = get_openai()
    resp = client.embeddings.create(model=EMBED_MODEL, input=text)
    return resp.data[0].embedding


def hybrid_retrieve(collection: str, query: str, dense_vec: list[float]) -> list[dict]:
    """Run hybrid (dense + BM25) retrieval with server-side RRF fusion.

    The Qdrant collection holds two NAMED vectors per point ("dense" and "bm25").
    Each Prefetch MUST specify `using=` or Qdrant returns 400 Bad Request.
    The BM25 sparse vector is computed server-side by passing a Document with
    `model="Qdrant/bm25"` — never build a SparseVector by hand here.
    """
    from qdrant_client.models import Document, Fusion, FusionQuery, Prefetch

    client = get_qdrant()
    result = client.query_points(
        collection_name=collection,
        prefetch=[
            Prefetch(
                query=dense_vec,
                using="dense",
                limit=PREFETCH_LIMIT,
            ),
            Prefetch(
                query=Document(text=query, model="Qdrant/bm25"),
                using="bm25",
                limit=PREFETCH_LIMIT,
            ),
        ],
        query=FusionQuery(fusion=Fusion.RRF),
        limit=CANDIDATES,
        with_payload=True,
    )

    candidates: list[dict] = []
    for point in result.points:
        payload = dict(point.payload or {})
        if not payload.get("text"):
            continue
        candidates.append(payload)
    return candidates


def rerank(query: str, candidates: list[dict]) -> list[dict]:
    if not candidates:
        return []
    co = get_cohere()
    docs = [str(c.get("text", ""))[:RERANK_CHAR_CAP] for c in candidates]
    response = co.rerank(
        model=RERANK_MODEL,
        query=query,
        documents=docs,
        top_n=min(TOP_K, len(docs)),
    )
    # response.results is sorted by relevance_score desc; map indices back.
    return [candidates[r.index] for r in response.results]


def _format_context(chunks: list[dict]) -> str:
    lines: list[str] = []
    for i, c in enumerate(chunks, start=1):
        doc = c.get("doc_name", "unknown")
        page = c.get("page", "n/a")
        text = str(c.get("text", "")).strip()
        lines.append(f"[Chunk {i}] (from {doc}, page {page})\n{text}")
    return "\n\n".join(lines)


SYSTEM_PROMPT = """You are ECES Economic Bot.

═══════════════════════════════════════
IDENTITY
═══════════════════════════════════════

You are a specialized assistant for economic analysis based on
economic reports.
You answer ONLY using content retrieved from your tools.
You NEVER use your own knowledge.

═══════════════════════════════════════
GREETING RULE
═══════════════════════════════════════

A message is a "pure greeting" ONLY if it contains no question
and no topic.

Pure greetings: "Hi", "Hello", "Hey", "Good morning", "Thanks",
                "مرحبا", "شكراً", "السلام عليكم"

NOT pure greetings: "Hi, what is X?", "Hello, can you explain Y?",
                    "مرحبا، ما هي توقعات الاقتصاد؟"

For pure greetings:
→ Do NOT call any tool.
→ Respond warmly and naturally — vary your wording.
→ Briefly mention what you can help with.
→ Keep it under 50 words.
→ Match the user's language and tone.

Style guide:
- Friendly, not robotic
- Don't repeat the same response every time
- Mention a couple of things you help with (trade data,
  economic outlooks, debt analysis, country profiles)
- End by inviting their question

Sample variations (adapt — do not copy verbatim):
- "Hi! I'm ECES Economic Bot. I can help with African trade
   data, economic outlooks, and country analysis. What would
   you like to explore?"
- "Hello! Happy to help. I cover African trade values,
   economic forecasts, and country profiles. What's on your mind?"
- "Hey there! I work with African trade and economic data.
   Ask me about trade flows, GDP outlooks, or debt analysis."
- "مرحبا! أنا مساعد اقتصادي متخصص في التجارة والاقتصاد الأفريقي.
   ما الذي تود معرفته؟"

If the message contains any question or topic alongside the
greeting, skip the greeting response and proceed to the
mandatory steps below.

═══════════════════════════════════════
CAPABILITY QUESTIONS
═══════════════════════════════════════

If the user asks about what you can do, what topics you cover,
what you know, or your capabilities — this is NOT a scope
rejection. Treat it as a meta-question and respond directly
without calling any tool.

Examples of capability questions:
- "What can you help me with?"
- "What topics do you cover?"
- "What do you know?"
- "Can you summarize what you can help me with?"
- "What is the most important information you have?"
- "How can you help me?"
- "Who are you?"
- "ماذا تستطيع أن تفعل؟"
- "ما هي المواضيع التي تغطيها؟"

For capability questions:
→ Do NOT call any tool.
→ Respond by listing what you cover, naturally and concisely:

"I can help you with topics from African trade and economic
reports, including:
- Bilateral trade values between African countries and the world
- Top trading partners and trade rankings
- Economic outlooks and growth forecasts
- Debt analysis and fiscal indicators
- Country profiles for African nations
- AfCFTA, regional integration, and trade policy

What would you like to explore?"

Vary the wording naturally. Adapt to the user's language and tone.

═══════════════════════════════════════
MANDATORY STEPS — FOR ALL OTHER QUESTIONS
═══════════════════════════════════════

STEP 1 — Call the qdrant_retriever tool with the user's question.
Do this before any reasoning. No exceptions.

STEP 2 — Evaluate the question's topic:

Is the question seeking ECONOMIC INFORMATION (about trade, debt,
growth, country indicators, or specific economic facts)?

NO → respond EXACTLY:
"This is outside my scope. I am here to answer questions about
economic analysis based on my database."

YES → continue to Step 3.

NOTE: Greetings and capability questions are handled in their
own sections above. Do NOT route them through this step.

STEP 3 — Evaluate retrieved content:

Did the tool return content relevant to the question?

NO → respond EXACTLY:
"I don't have information about that in my database. My sources
cover economic reports. Is there something else I can help with?"

YES → answer using ONLY that content with citations.

═══════════════════════════════════════
ANSWERING RULES
═══════════════════════════════════════

- Use ONLY retrieved content.
- Aim for a structured, detailed answer when the chunks support it
  (typically 3–6 sentences). Separate sentences for the figure,
  the driver/cause, the trend or comparison, and any caveat.
- Every claim must be grounded in a chunk and carry an inline
  [N] citation that matches the Sources block.
- Do NOT pad with generic context. Every sentence must add a fact
  that comes from a chunk — no waffle, no filler, no hedging
  language that isn't in the source.
- Do NOT infer or generalize beyond retrieved text.
- Do NOT answer from training knowledge.
- Respond in the same language the user wrote in.

═══════════════════════════════════════
CITATION RULE
═══════════════════════════════════════

After every answer that uses retrieved content, list EVERY
chunk used to construct the answer in the structured block below.

Rules:
- Cite each chunk that contributed any fact.
- Same document + different pages → separate entries.
- Same document + same page → ONE entry (merge in the Reasoning).
- Use inline [1], [2], [3] matching the Sources order.
- Snippet MUST be a verbatim sentence or clause copied from the
  chunk — not a paraphrase, not a summary. Wrap it in quotes.
- Reasoning MUST be ONE short sentence (≤ 20 words) that names
  the specific claim, figure, or phrase from the answer that this
  chunk supplied. NEVER write generic filler like "provides
  context" or "relevant background".

Format (exact — no bullets, no extra blank lines inside an entry):
Sources:
[1] {doc_name}, page {page_num}
Snippet: "{verbatim line from the chunk}"
Reasoning: {one sentence naming the specific claim/figure}

[2] {doc_name}, page {page_num}
Snippet: "{verbatim line from the chunk}"
Reasoning: {one sentence naming the specific claim/figure}

Example:
Algeria's hydrocarbons accounted for roughly 92% of total exports
in 2024, with crude oil and natural gas dominating outbound trade
[1]. The fiscal deficit widened to 13.8% of GDP in 2024, driven by
higher current spending and softer hydrocarbon receipts [2]. AfCFTA
implementation is framed as a channel to diversify exports and
reduce single-commodity exposure over the medium term [3].

Sources:
[1] algeria-country-brief-2025, page 4
Snippet: "Hydrocarbons accounted for 92% of total exports in 2024, with crude and natural gas as the dominant categories."
Reasoning: Direct source of the 92% hydrocarbons-export figure and its composition.

[2] algeria-country-brief-2025, page 5
Snippet: "The fiscal deficit widened to 13.8% of GDP in 2024 amid higher current spending and softer hydrocarbon revenues."
Reasoning: Source of the 13.8% fiscal deficit figure and its drivers.

[3] trade-outlook-2026, page 4
Snippet: "AfCFTA implementation is expected to reduce reliance on hydrocarbon exports by widening intra-African trade flows."
Reasoning: Supplied the AfCFTA-as-diversification framing tied to the final claim.

Do NOT include Sources for: greetings, capability answers,
scope rejections, or "no data found" responses.
"""


def generate_answer(query: str, chunks: list[dict]) -> str:
    client = get_openai()
    context = _format_context(chunks)
    # The pipeline performs the qdrant retrieval before this call. We surface
    # the chunks under the "qdrant_retriever results" label so the model treats
    # them as the output of the tool the system prompt instructs it to call.
    user_msg = (
        f"User question: {query}\n\n"
        f"qdrant_retriever results:\n{context}"
    )
    resp = client.chat.completions.create(
        model=GEN_MODEL,
        temperature=0.2,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
    )
    return (resp.choices[0].message.content or "").strip()


# Regex helpers for splitting the model's Sources block off the answer body.
_SOURCES_HEADER_RE = re.compile(r"(?im)^\s*sources\s*:?\s*$")
_BULLET_LINE_RE = re.compile(r"^\s*(?:[-*•]|\d+\.)\s*(.+?)\s*$")
_BRACKET_NUM_RE = re.compile(r"^\s*\[(\d+)\]\s*(.+?)\s*$")
_SNIPPET_RE = re.compile(r"(?i)^\s*snippet\s*:\s*(.+?)\s*$")
_REASONING_RE = re.compile(r"(?i)^\s*reasoning\s*:\s*(.+?)\s*$")
_DOC_PAGE_RE = re.compile(
    r"^(.+?),\s*(?:page|p\.?|pp\.?)\s*(\d+)\s*$", re.IGNORECASE
)
# Quote chars we strip off snippet text (straight + curly, ASCII + Unicode).
_QUOTE_CHARS = "\"'`*_“”‘’«»"


def _clean_doc_name(s: str) -> str:
    return s.strip().strip("*_`'\"").strip()


def _unquote(s: str) -> str:
    return s.strip().strip(_QUOTE_CHARS).strip()


def _parse_doc_page(entry: str) -> tuple[str, int | None]:
    m = _DOC_PAGE_RE.match(entry)
    if m:
        doc = _clean_doc_name(m.group(1))
        try:
            return doc, int(m.group(2))
        except ValueError:
            return doc, None
    return _clean_doc_name(entry), None


def parse_answer_and_sources(text: str) -> tuple[str, list[dict]]:
    """Split a model response into (answer_body, structured_sources).

    The system prompt instructs the model to append a 'Sources:' block where
    each cited chunk is a 3-line entry:

        [N] doc_name, page X
        Snippet: "verbatim line from the chunk"
        Reasoning: one short sentence

    We strip the block off the displayed answer and parse it into structured
    data. We also tolerate the legacy bullet-list format ("- doc, page X") so
    older deploys / fall-through responses still surface citations.
    """
    headers = list(_SOURCES_HEADER_RE.finditer(text))
    if not headers:
        return text.strip(), []

    last = headers[-1]
    body = text[: last.start()].rstrip()
    tail = text[last.end():]

    sources: list[dict] = []
    current: dict | None = None

    def flush() -> None:
        nonlocal current
        if current is not None and current.get("doc_name"):
            sources.append(current)
        current = None

    for raw_line in tail.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Skip a stray "Sources:" repeat or section divider lines.
        if line.lower().startswith("sources"):
            continue

        # New entry — "[N] doc_name, page X"
        m_hdr = _BRACKET_NUM_RE.match(line)
        if m_hdr:
            flush()
            doc, page = _parse_doc_page(m_hdr.group(2).strip())
            current = {
                "doc_name": doc,
                "page": page,
                "snippet": "",
                "reasoning": "",
            }
            continue

        # Snippet / Reasoning continuation lines belong to the current entry.
        m_sn = _SNIPPET_RE.match(line)
        if m_sn and current is not None:
            current["snippet"] = _unquote(m_sn.group(1))
            continue
        m_rs = _REASONING_RE.match(line)
        if m_rs and current is not None:
            current["reasoning"] = m_rs.group(1).strip()
            continue

        # Legacy "- doc, page N" or bare "doc, page N" fallback.
        if current is None:
            m_bul = _BULLET_LINE_RE.match(line)
            entry = m_bul.group(1) if m_bul else line
            doc, page = _parse_doc_page(entry)
            if doc:
                sources.append(
                    {
                        "doc_name": doc,
                        "page": page,
                        "snippet": "",
                        "reasoning": "",
                    }
                )

    flush()

    # Dedupe by (doc, page) while preserving citation order.
    seen: set[tuple[str, int | None]] = set()
    deduped: list[dict] = []
    for s in sources:
        key = (s["doc_name"], s["page"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(s)
    return body, deduped


def _chunk_for(source: dict, chunks: list[dict]) -> tuple[str, str]:
    """Find (snippet, full_text) from the reranked chunks for a cited source.

    The snippet is a short preview shown inline; the full_text is the entire
    retrieved chunk and powers the "View full chunk" disclosure in the UI.
    """
    for c in chunks:
        cdoc = str(c.get("doc_name", "")).strip()
        cpage_raw = c.get("page")
        try:
            cpage = int(cpage_raw) if cpage_raw is not None else None
        except (TypeError, ValueError):
            cpage = None
        if cdoc == source["doc_name"] and cpage == source["page"]:
            text = str(c.get("text", "")).strip()
            snippet = text[:220] + ("…" if len(text) > 220 else "")
            return snippet, text
    return "", ""


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


app = FastAPI(title="EconBot API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/collections", response_model=CollectionsResponse)
def list_collections() -> CollectionsResponse:
    try:
        client = get_qdrant()
        result = client.get_collections()
        names = sorted(c.name for c in result.collections)
        return CollectionsResponse(collections=names)
    except RuntimeError as e:
        # Missing env vars — treat as configuration error.
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        log.error("Failed to list collections: %s\n%s", e, traceback.format_exc())
        raise HTTPException(
            status_code=503,
            detail=(
                "Could not reach Qdrant. Check QDRANT_URL and QDRANT_API_KEY in "
                f"backend/.env. ({type(e).__name__})"
            ),
        )


@app.post("/query", response_model=QueryResponse)
def query(req: QueryRequest) -> QueryResponse:
    question = (req.question or "").strip()
    collection = (req.collection or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is empty.")
    if not collection:
        raise HTTPException(status_code=400, detail="Collection is empty.")

    start = time.perf_counter()
    log.info(
        "query collection=%s question=%r",
        collection,
        question[:120] + ("…" if len(question) > 120 else ""),
    )

    try:
        dense_vec = embed_query(question)
        candidates = hybrid_retrieve(collection, question, dense_vec)
        log.info("hybrid retrieved %d candidates", len(candidates))

        if not candidates:
            latency_ms = int((time.perf_counter() - start) * 1000)
            return QueryResponse(
                answer=(
                    "No matching chunks were found in this collection. "
                    "Try rephrasing the question or selecting a different collection."
                ),
                sources=[],
                latency_ms=latency_ms,
            )

        reranked = rerank(question, candidates)
        log.info("reranked to %d chunks", len(reranked))

        raw_answer = generate_answer(question, reranked)
        answer_body, parsed = parse_answer_and_sources(raw_answer)

        # Sources are tied to what the model actually cited (the PDFs that
        # produced the answer), not the full rerank dump. We prefer the
        # model-chosen snippet (a verbatim line from the chunk that fed the
        # answer) and fall back to a truncated preview of the chunk text only
        # when the model omitted it.
        sources: list[SourceItem] = []
        for s in parsed:
            preview, full_text = _chunk_for(s, reranked)
            model_snippet = (s.get("snippet") or "").strip()
            sources.append(
                SourceItem(
                    doc_name=s["doc_name"],
                    page=s["page"],
                    snippet=model_snippet or preview,
                    reasoning=(s.get("reasoning") or "").strip(),
                    full_text=full_text,
                )
            )

        latency_ms = int((time.perf_counter() - start) * 1000)
        log.info(
            "query OK latency_ms=%d cited_sources=%d", latency_ms, len(sources)
        )
        return QueryResponse(
            answer=answer_body, sources=sources, latency_ms=latency_ms
        )

    except HTTPException:
        raise
    except RuntimeError as e:
        # Missing env vars or similar configuration error.
        log.error("Configuration error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        log.error("Query failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(
            status_code=500,
            detail=(
                f"Internal error while answering the query ({type(e).__name__}). "
                "Check the backend logs for details."
            ),
        )
