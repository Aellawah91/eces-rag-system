# EconBot (تحليل)

A local web application for the **Egyptian Centre for Economic Studies (ECES)**
that lets researchers query a corpus of African economic research documents
stored in Qdrant Cloud. *Tahleel* (تحليل) is Arabic for "analysis".

The retrieval pipeline performs hybrid search (dense embeddings + native BM25)
with server-side RRF fusion in Qdrant, reranks the top candidates with
Cohere, and produces a grounded answer with citations from `gpt-4o-mini`.

This repository is set up for **local development only** — both backend and
frontend run on the developer's machine via `localhost`.

---

## Architecture

```
Browser (Next.js, :3000)
        │  GET /collections, POST /query
        ▼
FastAPI backend (:8000)
        │
        ├─ OpenAI: text-embedding-3-small  →  query vector (1536d)
        ├─ Qdrant: query_points
        │      prefetch [dense, bm25]  →  RRF fusion  →  top 30
        ├─ Cohere: rerank-english-v3.0     →  top 10
        └─ OpenAI: gpt-4o-mini             →  grounded answer + (doc, p.) cites
        │
        ▼
JSON { answer, sources[], latency_ms }
```

---

## Prerequisites

- Python **3.10+**
- Node.js **18+** and `npm`
- API keys (set in `backend/.env`):
  - `OPENAI_API_KEY`
  - `QDRANT_URL` and `QDRANT_API_KEY` for the existing Qdrant cluster
  - `COHERE_API_KEY`

> The Qdrant collection must already contain points with two **named vectors**
> — `dense` (1536-d OpenAI embeddings) and `bm25` (Qdrant native sparse) — and
> payloads carrying at least `text`, `doc_name`, and `page`. The backend does
> not ingest data; it only queries.

---

## 1. Backend setup

```bash
cd backend
python -m venv venv
source venv/bin/activate            # macOS / Linux
# OR
venv\Scripts\activate                # Windows (PowerShell or cmd)

pip install -r requirements.txt

cp .env.example .env                 # macOS / Linux
# OR
copy .env.example .env               # Windows
# Edit backend/.env and replace any placeholder keys with your real ones.

uvicorn main:app --reload --port 8000
```

The backend uses `python-dotenv` and loads `backend/.env` automatically at
startup. You should see:

```
Uvicorn running on http://127.0.0.1:8000
```

Smoke-check the API in another terminal:

```bash
curl http://localhost:8000/health
# {"status":"ok"}

curl http://localhost:8000/collections
# {"collections":["economic_doc_openai", ...]}
```

---

## 2. Frontend setup (in a new terminal)

```bash
cd frontend
npm install
cp .env.local.example .env.local     # macOS / Linux
# OR
copy .env.local.example .env.local   # Windows
# Confirm NEXT_PUBLIC_BACKEND_URL=http://localhost:8000

npm run dev
```

---

## 3. Open the app

Visit **<http://localhost:3000>** in your browser.

---

## 4. Test query

1. Choose `economic_doc_openai` from the **Collection** dropdown.
2. Type: *"What was Egypt's GDP growth in 2022?"*
3. Press **Ask** (or hit Enter).
4. After ~5–10 seconds you should see a concise answer followed by an
   expandable **Sources** section listing the supporting documents and pages.

### Expected response shape

```json
{
  "answer": "Egypt's GDP growth in 2022 was approximately 6.6%, according to ...",
  "sources": [
    {
      "doc_name": "African Economic Outlook 2023",
      "page": 12,
      "snippet": "Egypt's real GDP grew at 6.6% in 2022..."
    }
  ],
  "latency_ms": 8420
}
```

---

## API reference

| Method | Path             | Body                                                | Returns |
|--------|------------------|-----------------------------------------------------|---------|
| GET    | `/health`        | —                                                   | `{"status":"ok"}` |
| GET    | `/collections`   | —                                                   | `{"collections":[...]}` |
| POST   | `/query`         | `{"collection":"...", "question":"..."}`            | `{"answer","sources","latency_ms"}` |

CORS is enabled for `http://localhost:3000` only.

---

## Troubleshooting

**`500 Internal Server Error` mentioning `OPENAI_API_KEY` (or another key)**
The backend can't find one of the four required environment variables. Make sure
`backend/.env` exists (not just `.env.example`) and that every key has a real
value. Restart `uvicorn` after edits.

**`/collections` returns `[]`**
The Qdrant cluster is reachable but contains no collections under this API key.
Double-check `QDRANT_URL` and `QDRANT_API_KEY`.

**`/collections` 503 "Could not reach Qdrant"**
Network/credential failure. Verify the cluster URL (including the `:6333` port)
and that the API key is active.

**Browser console shows a CORS error**
Confirm the backend is actually running on port `8000` and that
`NEXT_PUBLIC_BACKEND_URL` in `frontend/.env.local` matches. After editing that
file, restart `npm run dev`.

**`ImportError` for `Document` from `qdrant_client.models`**
You're on an older `qdrant-client`. Upgrade to **≥ 1.10**:
`pip install -U "qdrant-client>=1.10"`. Server-side BM25 via
`Document(text=..., model="Qdrant/bm25")` requires this version.

**Qdrant returns `Bad Request`**
The collection has multiple named vectors, so every `Prefetch` must specify
`using="dense"` or `using="bm25"`. The included code already does this — do not
remove the `using=` argument.

**Cohere `429 Too Many Requests`**
Wait a moment and retry, or temporarily lower the candidate count
(`CANDIDATES = 30` in `backend/main.py`).

**Empty answer / "No matching chunks were found"**
The hybrid retrieval returned nothing. Either the collection is empty, the
question is far from the corpus, or the payloads are missing a `text` field.

---

## Project layout

```
ECES RAG System/
├── README.md
├── render.yaml                      # one-click deploy blueprint for Render
├── .gitignore
├── backend/
│   ├── .env.example
│   ├── .gitignore
│   ├── requirements.txt
│   └── main.py
└── frontend/
    ├── .env.local.example
    ├── .gitignore
    ├── package.json
    ├── next.config.mjs
    ├── tsconfig.json
    ├── tailwind.config.ts
    ├── postcss.config.mjs
    └── app/
        ├── layout.tsx
        ├── globals.css
        └── page.tsx
```

---

## Deployment — Render (free tier)

Both services deploy to **Render** for free. The provided `render.yaml`
provisions them in one shot.

### One-time setup

1. Push this repository to GitHub (see the next section).
2. Sign in to <https://render.com> with your GitHub account.
3. Open **Blueprints → New Blueprint Instance**, pick this repo.
4. Render reads `render.yaml` and creates two services:
   - `econbot-backend` (FastAPI, Python 3.11)
   - `econbot-frontend` (Next.js, Node 20)
5. In **econbot-backend → Environment**, set the four secrets:
   - `OPENAI_API_KEY`
   - `QDRANT_URL`
   - `QDRANT_API_KEY`
   - `COHERE_API_KEY`
6. Render will give each service a URL like
   `https://econbot-backend-xxxx.onrender.com`. Copy the backend URL into the
   frontend's `NEXT_PUBLIC_BACKEND_URL` env var, and copy the frontend URL into
   the backend's `ALLOWED_ORIGINS` env var. Both services auto-redeploy.
7. Share the **frontend URL** as your demo link.

### Cold starts (free tier)

Free Render services spin down after ~15 minutes of inactivity. The first
request after a sleep takes about 50 seconds while the container wakes; after
that, latency is normal. For an always-on demo, upgrade either service to a
paid plan ($7/month each).

### CORS

The backend reads `ALLOWED_ORIGINS` from env (comma-separated). It defaults to
`http://localhost:3000` for local dev, but on Render you set it to your
frontend's URL.

### Updating after the first deploy

`git push` to your `main` branch — Render auto-deploys both services.

---

## Pushing this repo to GitHub

After cloning / when ready to publish:

```bash
cd "ECES RAG System"
git init -b main
git add .
git commit -m "Initial commit: EconBot RAG system"

# Create an empty repo on github.com (private), then:
git remote add origin https://github.com/<your-user>/eces-rag-system.git
git push -u origin main
```

The included `.gitignore` keeps `.env`, `node_modules/`, `.next/`, and
`__pycache__/` out of the repo. Only `.env.example` (with placeholder values)
is committed.
