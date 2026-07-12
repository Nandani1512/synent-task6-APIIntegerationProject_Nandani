# 🧑‍💻 GitHub Dev Portfolio Generator + AI Résumé Tailor

Turn any GitHub username into a beautiful, shareable developer portfolio — live stats,
skills, contribution heatmap, streaks, and a recruiter-ready résumé — then use **AI to
tailor your résumé to a specific job description**, grounded only in your real repos.

Built with **vanilla HTML/CSS/JS** on the front end and a small **Node + Express + Google
Gemini** service on the back end. No frameworks, no build step.

**🔗 Live demo (full app, incl. AI):** https://synent-task6-apiintegerationproject.onrender.com/


> The Render URL serves the whole app (front end **and** the AI backend), so the résumé-tailoring
> features work there out of the box. The GitHub Pages copy is the same front end, pointed at the
> Render backend for its AI calls.

---

## 📸 Screenshots

### Dashboard
![Dashboard — profile, stats, skills and repositories](screenshots/dashboard.png)

---

## ✨ Features

### Portfolio (front end, GitHub REST API)
- Live **profile, repos, languages, and public events** — fetched in **parallel** with `Promise.all`
- **Stats bar** with animated count-up (repos, stars, followers, following)
- **Skills** — top languages auto-detected from repos as % bars
- **Repositories** — cards with stars/forks/language; **pin/unpin** your best (saved per session)
- **Contribution heatmap** (53×7 CSS grid, 5 intensity levels, hover tooltips)
- **Streak counters** + **commit-activity chart** (Chart.js) + **recent activity feed**
- **Shareable card** (PNG) and **one-page résumé** layout
- Loading **skeletons**, friendly **error states** (404 / rate-limit / offline) with retry
- 🌗 Dark / light **theme toggle** (crisp SVG sun/moon icons), persisted
- 🔗 **Shareable URL** (`?user=`), ⏱️ **debounced** search, **sessionStorage** caching
- 🔑 Optional **GitHub token** (60 → 5,000 req/hr), live **rate-limit** indicator
- 🛡️ All API text is **sanitized** (no `innerHTML` with raw data)

### AI Résumé Tailoring (back end, Google Gemini)
- **Tailor Your Résumé** — paste a **job description**; the AI ranks your GitHub repos against
  it and rewrites the **Projects** region of your LaTeX résumé with ATS-optimized **X-Y-Z bullets**
  ("Accomplished X, measured by Y, by doing Z"), grounded **only** in real repo data (no invented metrics).
- **Bring-Your-Own-Template (BYOT)** — upload or paste your own `.tex`; the AI edits **only** the
  projects region between markers and preserves your exact style. A ready-to-use template is
  **preloaded**, and if your template has no markers we **insert them automatically** — so there's
  zero setup and nothing to configure.
- **Résumé enhancement API** — a JD-driven review endpoint that returns a keyword-match score,
  gaps, bullet rewrites, ATS fixes, and skill add/remove suggestions (advice only; never fabricates content).
- Skill **add/remove** suggestions and a **"repos considered"** transparency panel.
- The Gemini key lives **server-side only** — it never reaches the browser or git.

---

## 🧱 Architecture

```
Browser (static front end)                Node + Express backend (Render)         External
──────────────────────────                ───────────────────────────────        ──────────
index.html / app.html                      GET  /api/health                        GitHub REST API
style.css / script.js        ──fetch──▶    POST /api/resume/tailor   ──▶ Gemini ──▶ generativelanguage.googleapis.com
config.local.js (local only)               POST /api/resume/enhance                (gemini-2.5-flash)
        │                                          │
        └── GitHub REST API (direct, client-side) ─┘
```

- The **portfolio** talks to the GitHub API directly from the browser.
- The **AI résumé** features call the Node backend, which holds the Gemini key and calls Gemini via REST.
- `server.js` also serves the static front end, so a single Render service hosts the whole app.

---

## 📁 Project structure

```
.
├── index.html                 # Landing page
├── app.html                   # The generator app (portfolio + AI résumé tailor)
├── style.css                  # Theme variables, layout, skeletons, print/résumé styles
├── script.js                  # Fetch logic, DOM rendering, résumé builder, BYOT flow
├── config.local.example.js    # Template for an optional local GitHub token
├── screenshots/
└── backend/
    ├── server.js              # Express app + endpoints (serves static front end too)
    ├── package.json           # Scripts + deps (express, cors, dotenv, express-rate-limit)
    ├── .env.example           # Env template (copy to backend/.env)
    └── src/
        ├── models.js          # Typed shapes + normalizers (runtime shape safety)
        ├── prefilter.js       # Phase 1 — rank GitHub repos against the JD
        ├── github.js          # Fetch repos + READMEs from the GitHub API
        ├── llm.js             # Gemini transport + project-selection prompt
        ├── ats.js             # BYOT projects-region rewriter (format-preserving)
        ├── byot.js            # Injection-marker helpers (find / extract / replace region)
        ├── byotPipeline.js    # Orchestrator for the BYOT tailor flow
        ├── latex.js           # LaTeX generation helpers
        └── enhance.js         # JD-driven whole-résumé enhancement advisor
    └── test/
        ├── smoke.js           # Offline unit smoke (npm test)
        ├── byot.smoke.js      # BYOT pipeline smoke (mock fetch)
        ├── enhance.smoke.js   # Enhancement layer smoke (mock fetch)
        └── e2e.manual.js      # Manual end-to-end against a live key
```

---

## 🔌 Backend API

Base URL (deployed): `https://synent-task6-api-integeration-proje.vercel.app/`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET`  | `/api/health` | Liveness + config sanity (which model, whether keys are set) |
| `POST` | `/api/resume/tailor` | Tailor a LaTeX template's Projects region to a JD (BYOT) |
| `POST` | `/api/resume/enhance` | JD-driven résumé review: keyword match, gaps, bullet rewrites, ATS fixes |

<details>
<summary><code>POST /api/resume/tailor</code> — request/response</summary>

```jsonc
// Request
{
  "github_username": "octocat",
  "job_description": "Frontend Engineer: React, TypeScript, Docker…",
  "latex_template": "\\documentclass… % --- AI_PROJECTS_START --- % … % --- AI_PROJECTS_END --- %"
}
// Response
{
  "latex": "…full template with only the projects region rewritten…",
  "warnings": [],
  "skillsToAdd": ["Docker"],
  "skillsToRemove": ["jQuery"],
  "selectedProjects": [{ "name": "…", "action": "kept|replaced|added", "reason": "…" }],
  "consideredRepos": [{ "name": "…", "score": 0, "matchedKeywords": [], "hasReadme": true }]
}
```
</details>

<details>
<summary><code>POST /api/resume/enhance</code> — request/response</summary>

```jsonc
// Request
{ "resume_text": "…plain text or LaTeX source…", "job_description": "…" }
// Response
{
  "summary": "…",
  "keywordMatch": { "matchPercent": 70, "matchedKeywords": [], "missingKeywords": [] },
  "strengths": [],
  "gaps": [{ "gap": "…", "severity": "high|medium|low", "fix": "…" }],
  "bulletRewrites": [{ "original": "…", "suggested": "…", "why": "…" }],
  "atsIssues": [{ "issue": "…", "fix": "…" }],
  "skillsToAdd": [], "skillsToRemove": []
}
```
</details>

The tailor/enhance endpoints are **rate-limited** (10 req / 15 min per IP) to protect the Gemini quota.

---

## ▶️ Run locally

### 1. Front end only (portfolio, no AI)
Open `app.html` in a browser, or serve the folder:
```bash
python -m http.server 8000
# visit http://localhost:8000/app.html  (try ?user=torvalds)
```

### 2. With the AI backend
```bash
cd backend
cp .env.example .env          # then edit .env and add your GEMINI_API_KEY
npm install
npm start                     # serves the app + API at http://localhost:3000
```
Now open http://localhost:3000 — the whole app (portfolio + AI résumé) runs from one server.

To point a separately-hosted front end at a deployed backend, set in `config.local.js`:
```js
window.BACKEND_URL = "https://synent-task6-apiintegerationproject.onrender.com";
```

### Environment variables (`backend/.env`)
| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `GEMINI_API_KEY` | ✅ | — | Server-side only. Get one at https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | Any model your key can access |
| `GITHUB_TOKEN` | — | _(unauth)_ | Raises the server's GitHub limit (60 → 5,000/hr) |
| `PORT` | — | `3000` | Listen port |
| `CORS_ORIGINS` | — | `*` | Comma-separated allow-list, or `*` |

---

## 🚀 Deployment

### Backend + full app — Render
The deployed app runs as a Node **Web Service** on Render.

1. Push the repo to GitHub.
2. In Render → **New → Web Service** → connect this repo.
3. Configure:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start` (i.e. `node server.js`)
   - **Environment:** add `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, `GITHUB_TOKEN`).
4. **Auto-Deploy: On** — every push to `main` triggers a new deploy automatically (watch the
   **Events** tab). Free-tier services sleep when idle, so the first request after a while takes
   ~30–60s to wake.

Because `server.js` serves the static front end from the repo root, the single Render URL hosts
the entire app: https://synent-task6-apiintegerationproject.onrender.com/

### Front end — GitHub Pages (optional mirror)
The static site can also be served from Pages:

1. Repo → **Settings → Pages** → Source: **Deploy from a branch** → `main` / `/ (root)` → Save.
2. Live at `https://<user>.github.io/<repo>/` after ~1 min; pushes to `main` republish automatically.
3. Set `window.BACKEND_URL` (in `config.local.js` or committed config) to the Render URL so the
   AI features reach the backend.

> `config.local.js` and `backend/.env` are gitignored — **no token or key is ever deployed**.
> Hard-refresh (`Ctrl+Shift+R`) after a deploy to beat browser cache.

---

## 🔑 GitHub token (optional, front end)
The token is **optional** — anyone can browse any public profile without one; it only raises the
rate limit from **60 → 5,000 req/hr**. Add it either at runtime via the **key** button (stored in
`localStorage`) or locally by copying `config.local.example.js` → `config.local.js` (gitignored).
Generate one at https://github.com/settings/tokens — **no scopes needed**.

> 🔒 Never commit a real token/key or paste one into a screenshot/issue. If exposed, revoke it immediately.

---

## 🧪 Testing
```bash
cd backend
npm test            # offline unit smoke
npm run test:enhance   # enhancement-layer smoke (mock Gemini)
node test/byot.smoke.js   # BYOT pipeline smoke (mock fetch)
```
The front end has a manual test plan in [`TESTING.md`](TESTING.md).

---

## ⚠️ Known limitations
- GitHub's public-events API returns only the **last ~90 days / 300 events**, so the heatmap and
  streaks reflect recent activity, not a full year.
- Language percentages are tallied from the **top starred repos** to stay within the rate limit.
- AI bullets are grounded strictly in repo data — if a repo's README is thin, that repo may be skipped.
- The `/api/resume/enhance` endpoint is live as an API but is **not yet wired into the UI**.

---

Built by **Nandani** · GitHub REST API · Google Gemini · Node/Express · Vanilla JS
