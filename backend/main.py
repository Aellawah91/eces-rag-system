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
- Be concise and direct.
- Do NOT infer or generalize beyond retrieved text.
- Do NOT answer from training knowledge.
- Respond in the same language the user wrote in.

═══════════════════════════════════════
CITATION RULE
═══════════════════════════════════════

After every answer that uses retrieved content, list EVERY
chunk used to construct the answer.

Rules:
- Cite each chunk that contributed any fact
- Same document + different pages → separate lines
- Same document + same page → one line
- Use inline [1], [2], [3] matching the Sources order

Format:
Sources:
- {doc_name}, page {page_num}
- {doc_name}, page {page_num}

Example:
Algeria's hydrocarbons account for over 90% of exports [1].
The fiscal deficit was 13.8% of GDP in 2024 [2].
AfCFTA helps reduce exposure to external shocks [3].

Sources:
- algeria-country-brief-2025, page 4
- algeria-country-brief-2025, page 5
- trade-outlook-2026, page 4

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
_DOC_PAGE_RE = re.compile(
    r"^(.+?),\s*(?:page|p\.?|pp\.?)\s*(\d+)\s*$", re.IGNORECASE
)


def _clean_doc_name(s: str) -> str:
    return s.strip().strip("*_`'\"").strip()


def parse_answer_and_sources(text: str) -> tuple[str, list[dict]]:
    """Split a model response into (answer_body, structured_sources).

    The system prompt instructs the model to append a 'Sources:' block listing
    each cited (doc_name, page). When present, we strip the block off the
    displayed answer and surface it as structured data so the UI can render
    clean PDF references instead of the full rerank dump.
    """
    headers = list(_SOURCES_HEADER_RE.finditer(text))
    if not headers:
        return text.strip(), []

    last = headers[-1]
    body = text[: last.start()].rstrip()
    tail = text[last.end():]

    sources: list[dict] = []
    seen: set[tuple[str, int | None]] = set()
    for line in tail.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.lower().startswith("sources"):
            continue
        m = _BULLET_LINE_RE.match(stripped)
        entry = m.group(1) if m else stripped
        m2 = _DOC_PAGE_RE.match(entry)
        if m2:
            doc = _clean_doc_name(m2.group(1))
            try:
                page: int | None = int(m2.group(2))
            except ValueError:
                page = None
        else:
            doc = _clean_doc_name(entry)
            page = None
        if not doc:
            continue
        key = (doc, page)
        if key in seen:
            continue
        seen.add(key)
        sources.append({"doc_name": doc, "page": page})

    return body, sources


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
        # produced the answer), not the full rerank dump.
        sources: list[SourceItem] = []
        for s in parsed:
            snippet, full_text = _chunk_for(s, reranked)
            sources.append(
                SourceItem(
                    doc_name=s["doc_name"],
                    page=s["page"],
                    snippet=snippet,
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
