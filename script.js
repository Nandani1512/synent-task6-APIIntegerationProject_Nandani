/* ============================================================
   GitHub Dev Portfolio Generator — script.js
   Phase 1: fetch layer, hero section, theme, debounced input.
   Vanilla JS, Fetch API, Promise.all, sessionStorage.
   ============================================================ */
"use strict";

/* ---------- constants ---------- */
const API = "https://api.github.com";
// Base URL of the JD->LaTeX backend. Override in config.local.js with
// `window.BACKEND_URL = "https://your-backend…"` to point at a deployed server.
const BACKEND_URL = (typeof window !== "undefined" && window.BACKEND_URL) || "https://synent-task6-apiintegerationproject.onrender.com";
const TOKEN_KEY = "ghpf_token";
const LANG_FETCH_LIMIT = 3;      // cap per-repo language calls to protect the 60/hr rate limit
const TOP_LANGS = 8;             // skill bars to show
const HEAT_WEEKS = 53;           // columns in the contribution heatmap
const PIN_KEY = (u) => `ghpf_pins_${u.toLowerCase()}`;
const CACHE_KEY = (u) => `ghpf_cache_${u.toLowerCase()}`;
const RESUME_KEY = (u) => `ghpf_resume_${u.toLowerCase()}`;   // localStorage — persists across sessions

/* ---------- tiny DOM helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element with props + children. Text is always set via textContent (safe). */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;        // safe — never parsed as HTML
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}



/* ---------- app state ---------- */
const state = {
  username: "",
  user: null,
  repos: [],
  languages: {},   // { lang: bytes }
  repoLangs: {},   // { repoId: [topLang, …] }
  events: [],
  pins: new Set(),
  chart: null,
};

/* ============================================================
   THEME (CSS-variable based dark / light toggle)
   ============================================================ */
(function initTheme() {
  const saved = localStorage.getItem("ghpf_theme");
  if (saved) document.documentElement.dataset.theme = saved;
  syncThemeIcon();
})();
function syncThemeIcon() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("#themeToggle").textContent = dark ? "☀️" : "🌙";
}
$("#themeToggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("ghpf_theme", next);
  syncThemeIcon();
  // redraw the chart so its colours follow the new theme
  if (state.events.length) renderCommitChart(state.events);
  // the share card uses its own theme presets, but redraw so the avatar/data stay fresh
  if (state.user) renderShareCard();
});

/* ============================================================
   TOKEN HANDLING (raises rate limit 60 -> 5000)
   Token is OPTIONAL — the app works for everyone without one.
   Read from localStorage (persists across sessions) OR sessionStorage
   (used by config.local.js). Saving via the 🔑 panel uses localStorage
   so you only paste it once, ever.
   ============================================================ */
function getToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
}

$("#tokenBtn").addEventListener("click", () => {
  const panel = $("#tokenPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) { $("#tokenInput").value = getToken(); $("#tokenInput").focus(); }
});
$("#tokenSave").addEventListener("click", () => {
  const v = $("#tokenInput").value.trim();
  if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY);
  $("#tokenPanel").hidden = true;
  toast(v ? "Token saved (persists on this device)" : "Token cleared");
  // re-fetch the current profile with the new (higher) limit
  if (state.username) { sessionStorage.removeItem(CACHE_KEY(state.username)); generate(state.username); }
});
$("#tokenClear").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  $("#tokenInput").value = "";
  toast("Token cleared");
});

/* ============================================================
   FETCH LAYER
   ============================================================ */
/** Build auth headers when a token is present. */
function authHeaders() {
  const h = { Accept: "application/vnd.github+json" };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** A typed error so callers can branch on kind. */
class GHError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}

/**
 * Fetch a GitHub endpoint.
 * Throws GHError with kind: 'notfound' | 'ratelimit' | 'network' | 'http'.
 */
async function ghFetch(path) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers: authHeaders() });
  } catch (err) {
    throw new GHError("network", "Network request failed. Check your connection.", 0);
  }
  updateRateLimit(res.headers);

  if (res.ok) return res.json();

  if (res.status === 404) throw new GHError("notfound", "User not found.", 404);
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("X-RateLimit-Remaining");
    if (remaining === "0") throw new GHError("ratelimit", "GitHub API rate limit reached.", res.status);
    throw new GHError("http", "Access forbidden by GitHub (403).", res.status);
  }
  throw new GHError("http", `GitHub returned an unexpected status (${res.status}).`, res.status);
}

/** Read X-RateLimit-Remaining / -Limit from a response and reflect it in the top bar. */
function updateRateLimit(headers) {
  const remaining = headers.get("X-RateLimit-Remaining");
  const limit = headers.get("X-RateLimit-Limit");
  if (remaining == null) return;
  const node = $("#rateLimit");
  node.textContent = `API: ${remaining}/${limit ?? "?"} left`;
  node.classList.toggle("low", Number(remaining) <= 5);
}

/* ============================================================
   MAIN ORCHESTRATION
   ============================================================ */
async function generate(username) {
  username = username.trim().replace(/^@/, "");
  if (!username) return;
  state.username = username;

  $("#usernameInput").value = username;
  setShareParam(username);

  // Reset the résumé-tailor form for a fresh user search.
  // The CodeMirror editor (uploaded template) is LEFT INTACT per spec.
  resetByotState();

  hideError();
  showSkeleton(true);

  // sessionStorage cache: a repeat lookup this session skips the network entirely.
  const cached = readCache(username);
  if (cached) {
    applyData(cached, username);
    showSkeleton(false);
    toast("Loaded from session cache");
    return;
  }

  try {
    // --- PARALLEL fetch with Promise.all of the three primary endpoints ---
    const [user, repos, events] = await Promise.all([
      ghFetch(`/users/${encodeURIComponent(username)}`),
      ghFetch(`/users/${encodeURIComponent(username)}/repos?sort=stars&per_page=100`),
      ghFetch(`/users/${encodeURIComponent(username)}/events/public?per_page=100`),
    ]);

    // --- PARALLEL fetch of per-repo language byte counts (top repos only) ---
    const langTargets = [...repos]
      .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
      .slice(0, LANG_FETCH_LIMIT);

    const langResults = await Promise.all(
      langTargets.map((r) =>
        ghFetch(`/repos/${r.owner.login}/${encodeURIComponent(r.name)}/languages`)
          .catch(() => ({}))   // one failed repo must not sink the whole portfolio
      )
    );

    // tally byte counts across all fetched repos
    const languages = {};
    const repoLangs = {};   // per-repo top languages, for the résumé project cards
    langTargets.forEach((repo, i) => {
      const map = langResults[i] || {};
      const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]).map(([k]) => k);
      repoLangs[repo.id] = sorted.length ? sorted : (repo.language ? [repo.language] : []);
      for (const [lang, bytes] of Object.entries(map)) {
        languages[lang] = (languages[lang] || 0) + bytes;
      }
    });
    // fall back to the primary `language` field for repos beyond the cap,
    // weighted by repo size (KB→bytes) so their % is comparable to the
    // byte-counted top repos — otherwise a +1 tally rounds to 0.0%.
    for (const r of repos.slice(LANG_FETCH_LIMIT)) {
      if (r.language) {
        const weight = (r.size || 0) * 1024 || 2048;   // small floor for empty repos
        languages[r.language] = (languages[r.language] || 0) + weight;
      }
    }

    const data = { user, repos, languages, repoLangs, events };
    writeCache(username, data);
    applyData(data, username);
  } catch (err) {
    showError(err);
  } finally {
    showSkeleton(false);
  }
}

/** Push a fetched-or-cached data bundle into state and render every section. */
function applyData(data, username) {
  state.user = data.user;
  state.repos = data.repos;
  state.languages = data.languages;
  state.repoLangs = data.repoLangs || {};
  state.events = data.events || [];
  state.pins = loadPins(username);

  $("#portfolio").hidden = false;
  revealOnScroll();                 // tag panels/stat-cards for fade-in-up
  renderHero(data.user);
  renderStats(data.user, data.repos);
  renderSkills(data.languages);
  renderRepos(data.repos);
  renderHeatmap(state.events);
  renderStreaks(state.events);
  renderCommitChart(state.events);
  renderFeed(state.events);
  renderShareCard();              // draw the shareable stats card

  loadResumeIntoForm(username);   // prefill the editor (API data + any saved details)
  renderResume();                 // build the print-only résumé
}

/* ============================================================
   sessionStorage CACHING
   ============================================================ */
function readCache(username) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY(username));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeCache(username, data) {
  try { sessionStorage.setItem(CACHE_KEY(username), JSON.stringify(data)); }
  catch { /* quota exceeded — just means we re-fetch next time */ }
}

/* ============================================================
   RENDER: HERO
   ============================================================ */
function renderHero(user) {
  $("#heroCard").hidden = false;
  $("#avatar").src = user.avatar_url;
  $("#avatar").alt = `${user.login} avatar`;
  $("#profileName").textContent = user.name || user.login;

  const login = $("#profileLogin");
  login.textContent = `@${user.login}`;
  login.href = user.html_url;

  $("#profileBio").textContent = user.bio || "";

  const loc = $("#factLocation");
  if (user.location) { loc.hidden = false; loc.querySelector("span:last-child").textContent = user.location; }
  else loc.hidden = true;

  const joined = $("#factJoined");
  if (user.created_at) {
    joined.hidden = false;
    joined.querySelector("span:last-child").textContent = `Joined ${new Date(user.created_at).getFullYear()}`;
  }

  const link = $("#factLink");
  link.hidden = false;
  link.querySelector("a").href = user.html_url;
}

/* ============================================================
   RENDER: STATS  (animated count-up)
   ============================================================ */
function renderStats(user, repos) {
  const totalStars = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  animateCounter($('[data-stat="repos"]'), user.public_repos ?? repos.length);
  animateCounter($('[data-stat="stars"]'), totalStars);
  animateCounter($('[data-stat="followers"]'), user.followers ?? 0);
  animateCounter($('[data-stat="following"]'), user.following ?? 0);
}

/**
 * Count up from 0 to `target` with an easeOutCubic curve.
 * @param {HTMLElement} node     element whose textContent is updated
 * @param {number}      target   final number to reach
 * @param {number}      duration animation length in ms (default 1500)
 */
function animateCounter(node, target, duration = 1500) {
  if (!node) return;
  target = Number(target) || 0;
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = Math.round(eased * target).toLocaleString();
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
/* Alias — the requested reusable count-up utility. */
const countUp = animateCounter;

/* ============================================================
   RENDER: SKILLS  (top languages with % bars)
   ============================================================ */
const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", Java: "#b07219",
  HTML: "#e34c26", CSS: "#563d7c", "C++": "#f34b7d", C: "#555555", "C#": "#178600",
  Go: "#00ADD8", Rust: "#dea584", Ruby: "#701516", PHP: "#4F5D95", Swift: "#F05138",
  Kotlin: "#A97BFF", Shell: "#89e051", Vue: "#41b883", Dart: "#00B4AB",
  "Jupyter Notebook": "#DA5B0B", Scala: "#c22d40", Elixir: "#6e4a7e",
};
function langColor(name) { return LANG_COLORS[name] || "#8b949e"; }

function renderSkills(languages) {
  const body = $("#skillsBody");
  body.replaceChildren();

  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    body.appendChild(el("p", { class: "hint", text: "No language data available." }));
    return;
  }
  const total = entries.reduce((s, [, b]) => s + b, 0);
  const top = entries.slice(0, TOP_LANGS);

  for (const [name, bytes] of top) {
    const pct = (bytes / total) * 100;
    const pctText = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    const fill = el("div", { class: "skill-fill" });
    fill.style.background = langColor(name);

    body.appendChild(el("div", { class: "skill" }, [
      el("div", { class: "skill-head" }, [
        el("span", { class: "skill-name", text: name }),
        el("span", { class: "skill-pct", text: `${pctText}%` }),
      ]),
      el("div", { class: "skill-bar" }, [fill]),
    ]));
    // animate the bar width in after paint
    requestAnimationFrame(() => { fill.style.width = `${pct}%`; });
  }
}

/* ============================================================
   RENDER: REPOS  (pin / unpin -> sessionStorage)
   ============================================================ */
function loadPins(username) {
  try {
    const raw = sessionStorage.getItem(PIN_KEY(username));
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}
function savePins() {
  sessionStorage.setItem(PIN_KEY(state.username), JSON.stringify([...state.pins]));
}

function renderRepos(repos) {
  const body = $("#reposBody");
  body.replaceChildren();

  if (!repos.length) {
    body.appendChild(el("p", { class: "hint", text: "No public repositories." }));
    return;
  }

  // pinned first (in star order), then the rest by stars
  const sorted = [...repos].sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
  const pinned = sorted.filter((r) => state.pins.has(r.id));
  const rest = sorted.filter((r) => !state.pins.has(r.id));
  const visible = [...pinned, ...rest].slice(0, Math.max(6, pinned.length + 6));

  for (const r of visible) body.appendChild(repoCard(r));
}

function repoCard(r) {
  const isPinned = state.pins.has(r.id);

  const pinBtn = el("button", {
    class: `repo-pin ${isPinned ? "active" : ""}`,
    title: isPinned ? "Unpin" : "Pin",
    "aria-label": isPinned ? "Unpin repository" : "Pin repository",
    text: isPinned ? "✓" : "⊕",
    onclick: () => togglePin(r.id),
  });

  const foot = el("div", { class: "repo-foot" });
  if (r.language) {
    const dot = el("span", { class: "lang-dot" });
    dot.style.background = langColor(r.language);
    foot.appendChild(el("span", { class: "lang-badge" }, [dot, el("span", { text: r.language })]));
  }
  foot.appendChild(el("span", { text: `★ ${(r.stargazers_count || 0).toLocaleString()}` }));
  foot.appendChild(el("span", { text: `⑂ ${(r.forks_count || 0).toLocaleString()}` }));

  const children = [];
  if (isPinned) children.push(el("div", { class: "pinned-label", text: "📌 Pinned" }));
  children.push(pinBtn);
  children.push(el("a", {
    class: "repo-name", href: r.html_url, target: "_blank", rel: "noopener noreferrer", text: r.name,
  }));
  children.push(el("p", { class: "repo-desc", text: r.description || "No description provided." }));
  children.push(foot);

  return el("div", { class: `repo-card ${isPinned ? "pinned" : ""}` }, children);
}

function togglePin(id) {
  if (state.pins.has(id)) state.pins.delete(id); else state.pins.add(id);
  savePins();
  renderRepos(state.repos);
}

/* ============================================================
   PUSH-EVENT HELPERS  (shared by heatmap + streaks + chart)
   ============================================================ */
/** Local YYYY-MM-DD for a Date. */
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Map of YYYY-MM-DD -> number of push events that day. */
function buildPushMap(events) {
  const map = new Map();
  for (const ev of events) {
    if (ev.type !== "PushEvent") continue;
    const key = ev.created_at.slice(0, 10);    // already YYYY-MM-DD (UTC)
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

/** 5 intensity buckets: 0, 1-2, 3-5, 6-9, 10+. */
function heatLevel(count) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

/* ============================================================
   RENDER: HEATMAP  (53 weeks x 7 days)
   ============================================================ */
function renderHeatmap(events) {
  const map = buildPushMap(events);
  const grid = $("#heatmap");
  grid.replaceChildren();

  const today = new Date(); today.setHours(0, 0, 0, 0);
  // start = today minus (HEAT_WEEKS-1) weeks, then walk back to that week's Sunday
  const start = new Date(today);
  start.setDate(start.getDate() - (HEAT_WEEKS - 1) * 7);
  start.setDate(start.getDate() - start.getDay()); // 0 = Sunday

  // Iterating dates ascending fills the grid column-by-column (grid-auto-flow: column, 7 rows).
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = ymd(d);
    const count = map.get(key) || 0;
    const cell = el("div", {
      class: `heat-cell lvl-${heatLevel(count)}`,
      dataset: { date: key, count: String(count) },
    });
    cell.addEventListener("mouseenter", showHeatTooltip);
    cell.addEventListener("mousemove", showHeatTooltip);
    cell.addEventListener("mouseleave", hideHeatTooltip);
    grid.appendChild(cell);
  }
}

function showHeatTooltip(e) {
  const t = $("#heatTooltip");
  const { date, count } = e.target.dataset;
  const nice = new Date(date + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
  const n = Number(count);
  t.textContent = `${n} push event${n === 1 ? "" : "s"} · ${nice}`;
  t.hidden = false;
  t.style.left = `${e.clientX}px`;
  t.style.top = `${e.clientY}px`;
}
function hideHeatTooltip() { $("#heatTooltip").hidden = true; }

/* ============================================================
   RENDER: STREAKS
   ============================================================ */
/** Compute { current, longest } push-day streaks from a push-count Map. */
function computeStreaks(events) {
  const map = buildPushMap(events);

  // current streak: walk backwards from today (1-day grace if today is empty)
  let current = 0;
  const cursor = new Date(); cursor.setHours(0, 0, 0, 0);
  if (!map.has(ymd(cursor)) && map.size) cursor.setDate(cursor.getDate() - 1);
  while (map.has(ymd(cursor))) { current++; cursor.setDate(cursor.getDate() - 1); }

  // longest streak: scan sorted unique days for the longest consecutive run
  const days = [...map.keys()].sort();
  let longest = 0, run = 0, prev = null;
  for (const key of days) {
    const d = new Date(key + "T00:00:00");
    if (prev && (d - prev) === 86400000) run++; else run = 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest, activeDays: map.size };
}

function renderStreaks(events) {
  const { current, longest } = computeStreaks(events);
  animateCounter($('[data-stat="current"]'), current);
  animateCounter($('[data-stat="longest"]'), longest);
}

/* ============================================================
   RENDER: COMMIT ACTIVITY CHART  (Chart.js)
   ============================================================ */
function renderCommitChart(events) {
  const canvas = $("#commitChart");
  if (!window.Chart) return; // CDN not ready yet — redrawn on window 'load' below

  // build last-30-days buckets of push counts (sum of commits in each push payload)
  const byDay = new Map();
  for (const ev of events) {
    if (ev.type !== "PushEvent") continue;
    const key = ev.created_at.slice(0, 10);
    const commits = (ev.payload && ev.payload.commits && ev.payload.commits.length) || 1;
    byDay.set(key, (byDay.get(key) || 0) + commits);
  }

  const labels = [], counts = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    counts.push(byDay.get(ymd(d)) || 0);
  }

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--accent").trim() || "#2f81f7";
  const grid = styles.getPropertyValue("--border").trim() || "#30363d";
  const textDim = styles.getPropertyValue("--text-dim").trim() || "#8b949e";

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ label: "Commits", data: counts, backgroundColor: accent, borderRadius: 4, maxBarThickness: 18 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => i[0].label } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: textDim, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
        y: { beginAtZero: true, ticks: { color: textDim, precision: 0 }, grid: { color: grid } },
      },
    },
  });
}

/* ============================================================
   RENDER: ACTIVITY FEED
   ============================================================ */
const EVENT_META = {
  PushEvent: { icon: "⬆️", verb: "pushed to" },
  PullRequestEvent: { icon: "🔀", verb: "opened a pull request in" },
  IssuesEvent: { icon: "🐛", verb: "updated an issue in" },
  ForkEvent: { icon: "🍴", verb: "forked" },
  WatchEvent: { icon: "⭐", verb: "starred" },
  CreateEvent: { icon: "✨", verb: "created" },
  DeleteEvent: { icon: "🗑️", verb: "deleted a ref in" },
  IssueCommentEvent: { icon: "💬", verb: "commented in" },
  ReleaseEvent: { icon: "🏷️", verb: "released in" },
  PublicEvent: { icon: "📢", verb: "open-sourced" },
};

function renderFeed(events) {
  const body = $("#feedBody");
  body.replaceChildren();

  const list = events.slice(0, 10);
  if (!list.length) {
    body.appendChild(el("li", { class: "hint", text: "No recent public activity." }));
    return;
  }

  for (const ev of list) {
    const meta = EVENT_META[ev.type] || { icon: "📌", verb: "did something in" };
    const repoName = ev.repo ? ev.repo.name : "";
    const repoLink = el("a", {
      href: `https://github.com/${repoName}`, target: "_blank", rel: "noopener noreferrer", text: repoName,
    });

    const text = el("div", { class: "feed-text" }, [
      el("strong", { text: meta.verb }), " ", repoLink,
    ]);

    body.appendChild(el("li", { class: "feed-item" }, [
      el("span", { class: "feed-icon", text: meta.icon }),
      el("div", { class: "feed-main" }, [
        text,
        el("div", { class: "feed-time", text: timeAgo(ev.created_at) }),
      ]),
    ]));
  }
}

/* ============================================================
   timeAgo — human-readable relative timestamps
   ============================================================ */
function timeAgo(dateStr) {
  const then = new Date(dateStr).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units = [
    ["year", 31536000], ["month", 2592000], ["week", 604800],
    ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [name, size] of units) {
    const v = Math.floor(secs / size);
    if (v >= 1) return `${v} ${name}${v === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/* ============================================================
   LOADING / ERROR STATES
   ============================================================ */
function showSkeleton(on) {
  $("#heroSkeleton").hidden = !on;
  $("#portfolioSkeleton").hidden = !on;
  if (on) { $("#heroCard").hidden = true; $("#portfolio").hidden = true; }
  $("#generateBtn").disabled = on;
  $("#generateBtn").textContent = on ? "Loading…" : "Generate";
}

function showError(err) {
  const panel = $("#errorPanel");
  const kind = err instanceof GHError ? err.kind : "http";

  const presets = {
    notfound: { icon: "🔍", title: "User not found", msg: `No GitHub user named “${state.username}”. Check the spelling and try again.` },
    ratelimit: { icon: "⏳", title: "Rate limit reached", msg: "You've hit GitHub's unauthenticated limit (60/hour). Add a personal access token via the 🔑 button to raise it to 5,000/hour, then retry." },
    network: { icon: "📡", title: "Network error", msg: "Couldn't reach GitHub. Check your internet connection and retry." },
    http: { icon: "⚠️", title: "Something went wrong", msg: err.message || "An unexpected error occurred." },
  };
  const p = presets[kind] || presets.http;

  // All fields assigned via textContent, so raw user input is never parsed as HTML.
  $("#errorIcon").textContent = p.icon;
  $("#errorTitle").textContent = p.title;
  $("#errorMessage").textContent = p.msg;

  $("#heroCard").hidden = true;
  $("#portfolio").hidden = true;
  panel.hidden = false;
}
function hideError() { $("#errorPanel").hidden = true; }

$("#retryBtn").addEventListener("click", () => {
  // a fresh attempt should bypass any stale cache for this user
  if (state.username) {
    sessionStorage.removeItem(CACHE_KEY(state.username));
    generate(state.username);
  }
});

/* ============================================================
   SHARE URL (button UI added in Phase 5)
   ============================================================ */
function setShareParam(username) {
  const url = new URL(window.location.href);
  url.searchParams.set("user", username);
  history.replaceState(null, "", url);
}

/* ============================================================
   SHARE URL + PDF EXPORT
   ============================================================ */
$("#shareBtn").addEventListener("click", async () => {
  const url = new URL(window.location.href);
  url.searchParams.set("user", state.username);
  const link = url.toString();
  try {
    await navigator.clipboard.writeText(link);
    flashButton($("#shareBtn"), "✓ Copied!");
    toast("Shareable link copied to clipboard");
  } catch {
    // clipboard API unavailable (e.g. file://) — fall back to a prompt
    window.prompt("Copy this shareable link:", link);
  }
});

/** Briefly swap a button's label to give visual confirmation. */
function flashButton(btn, msg) {
  const original = btn.textContent;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1600);
}

/* ============================================================
   RÉSUMÉ  (print-only one-page developer summary)
   Combines human-written details (localStorage) with live GitHub data.
   ============================================================ */
const RESUME_FIELDS = ["title", "email", "location", "linkedin", "portfolio",
  "summary", "lang", "frontend", "backend", "tools", "db", "projects"];
const RESUME_INPUT = {
  title: "resTitle", email: "resEmail", location: "resLocation", linkedin: "resLinkedin",
  portfolio: "resPortfolio", summary: "resSummary", lang: "resLang", frontend: "resFrontend",
  backend: "resBackend", tools: "resTools", db: "resDb", projects: "resProjects",
};
const HEAT_PALETTE = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"];

function loadResumeDetails(username) {
  try {
    const raw = localStorage.getItem(RESUME_KEY(username));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveResumeDetails(username, details) {
  try { localStorage.setItem(RESUME_KEY(username), JSON.stringify(details)); } catch { }
}

/** Prefill the editor form: saved values first, else sensible GitHub-derived defaults. */
function loadResumeIntoForm(username) {
  const saved = loadResumeDetails(username);
  const u = state.user || {};
  const topLangs = Object.entries(state.languages).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);

  const defaults = {
    title: "", email: u.email || "", location: u.location || "",
    linkedin: "", portfolio: u.blog || "", summary: u.bio || "",
    lang: topLangs.join(", "), frontend: "", backend: "", tools: "Git, GitHub", db: "", projects: "",
  };
  for (const f of RESUME_FIELDS) {
    $("#" + RESUME_INPUT[f]).value = saved[f] != null && saved[f] !== "" ? saved[f] : defaults[f];
  }
}

function gatherResumeForm() {
  const out = {};
  for (const f of RESUME_FIELDS) out[f] = $("#" + RESUME_INPUT[f]).value.trim();
  return out;
}

/** Parse "repo | why | a; b; c" lines into { repoNameLower: {why, bullets[]} }. */
function parseProjectNotes(text) {
  const map = {};
  for (const line of (text || "").split("\n")) {
    if (!line.trim()) continue;
    const [name, why, bullets] = line.split("|").map((s) => (s || "").trim());
    if (!name) continue;
    map[name.toLowerCase()] = {
      why: why || "",
      bullets: (bullets || "").split(";").map((b) => b.trim()).filter(Boolean),
    };
  }
  return map;
}

/* ---- résumé panel wiring ---- */
$("#resumeBtn").addEventListener("click", () => {
  const p = $("#resumePanel");
  p.hidden = !p.hidden;
  if (!p.hidden) loadResumeIntoForm(state.username);
});
$("#resClose").addEventListener("click", () => { $("#resumePanel").hidden = true; });
$("#resSave").addEventListener("click", () => {
  saveResumeDetails(state.username, gatherResumeForm());
  renderResume();
  $("#resumePanel").hidden = true;
  toast("Résumé details saved");
});

/* ---- build the résumé document ---- */
function resumeProjects() {
  const sorted = [...state.repos].sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
  const pinned = sorted.filter((r) => state.pins.has(r.id));
  const chosen = (pinned.length ? pinned : sorted).slice(0, 6);
  return chosen;
}

function renderResume() {
  const doc = $("#resumeDoc");
  doc.replaceChildren();
  if (!state.user) return;

  const u = state.user;
  const d = state.username ? { ...loadResumeDetails(state.username) } : {};
  // merge live form values if the panel is currently open/edited
  if (!$("#resumePanel").hidden) Object.assign(d, gatherResumeForm());

  const val = (k, fallback = "") => (d[k] && d[k].trim ? d[k].trim() : d[k]) || fallback;

  /* ---------- header ---------- */
  const name = u.name || u.login;
  const contact = el("div", { class: "r-contact" });
  const loc = val("location", u.location || "");
  if (loc) contact.appendChild(el("span", { text: loc }));
  if (val("email", u.email)) contact.appendChild(el("a", { href: `mailto:${val("email", u.email)}`, text: val("email", u.email) }));
  contact.appendChild(el("a", { href: u.html_url, text: `⌥ github.com/${u.login}` }));
  if (val("linkedin")) contact.appendChild(el("a", { href: val("linkedin"), text: "in/ LinkedIn" }));
  if (val("portfolio")) {
    let url = val("portfolio"); if (!/^https?:\/\//.test(url)) url = "https://" + url;
    contact.appendChild(el("a", { href: url, text: val("portfolio").replace(/^https?:\/\//, "") }));
  }

  const header = el("div", { class: "r-header" }, [
    el("div", { class: "r-name", text: name }),
    val("title") ? el("div", { class: "r-title", text: val("title") }) : null,
    contact,
  ]);
  doc.appendChild(header);

  /* ---------- summary ---------- */
  const summary = val("summary", u.bio || "");
  if (summary) {
    doc.appendChild(el("div", { class: "r-section" }, [
      el("h3", { text: "Summary" }),
      el("div", { class: "r-summary", text: summary }),
    ]));
  }

  /* ---------- tech stack (grouped) ---------- */
  const groups = [
    ["Languages", val("lang")], ["Frontend", val("frontend")], ["Backend", val("backend")],
    ["Tools", val("tools")], ["Databases", val("db")],
  ].filter(([, v]) => v);
  if (groups.length) {
    const dl = el("dl", { class: "r-skills" });
    for (const [label, v] of groups) {
      dl.appendChild(el("dt", { text: label }));
      dl.appendChild(el("dd", { text: v }));
    }
    doc.appendChild(el("div", { class: "r-section" }, [el("h3", { text: "Tech Stack" }), dl]));
  }

  /* ---------- GitHub stats snapshot ---------- */
  doc.appendChild(buildStatsSnapshot());

  /* ---------- projects ---------- */
  const notes = parseProjectNotes(val("projects"));
  const projects = resumeProjects();
  if (projects.length) {
    const sec = el("div", { class: "r-section" }, [
      el("h3", { text: state.pins.size ? "Pinned Projects" : "Top Projects" }),
    ]);
    for (const r of projects) sec.appendChild(buildProjectCard(r, notes));
    doc.appendChild(sec);
  }
}

function buildStatsSnapshot() {
  const u = state.user;
  const totalStars = state.repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const { current, longest, activeDays } = computeStreaks(state.events);

  const stats = el("div", { class: "r-stats" }, [
    el("div", { class: "r-stat" }, [el("b", { text: String(u.public_repos ?? state.repos.length) }), el("span", { text: "Repos" })]),
    el("div", { class: "r-stat" }, [el("b", { text: totalStars.toLocaleString() }), el("span", { text: "Stars" })]),
    el("div", { class: "r-stat" }, [el("b", { text: String(u.followers ?? 0) }), el("span", { text: "Followers" })]),
    el("div", { class: "r-stat" }, [el("b", { text: String(longest) }), el("span", { text: "Longest Streak" })]),
  ]);

  const streakLine = el("div", {
    class: "r-summary", text:
      `Current streak: ${current} day${current === 1 ? "" : "s"}  ·  Longest: ${longest} days  ·  Active days (recent): ${activeDays}`
  });

  // language bars (top 6)
  const langEntries = Object.entries(state.languages).sort((a, b) => b[1] - a[1]);
  const total = langEntries.reduce((s, [, b]) => s + b, 0) || 1;
  const langWrap = el("div", { class: "r-langs" });
  for (const [name, bytes] of langEntries.slice(0, 6)) {
    const pct = (bytes / total) * 100;
    const bar = el("i"); bar.style.width = `${pct}%`; bar.style.background = langColor(name);
    langWrap.appendChild(el("div", { class: "r-lang" }, [
      el("div", { class: "r-lang-head" }, [
        el("span", { text: name }), el("span", { text: `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%` }),
      ]),
      el("div", { class: "r-bar" }, [bar]),
    ]));
  }

  // mini heatmap
  const heat = buildMiniHeatmap(state.events);

  return el("div", { class: "r-section" }, [
    el("h3", { text: "GitHub Activity Snapshot" }),
    stats, streakLine, langWrap, heat,
    el("div", { class: "r-summary", text: "Contribution activity (last ~12 months of public pushes)" }),
  ]);
}

function buildMiniHeatmap(events) {
  const map = buildPushMap(events);
  const grid = el("div", { class: "r-heatmap" });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (HEAT_WEEKS - 1) * 7);
  start.setDate(start.getDate() - start.getDay());
  for (let dt = new Date(start); dt <= today; dt.setDate(dt.getDate() + 1)) {
    const c = el("div", { class: "r-heat-cell" });
    c.style.background = HEAT_PALETTE[heatLevel(map.get(ymd(dt)) || 0)];
    grid.appendChild(c);
  }
  return grid;
}

function buildProjectCard(r, notes) {
  const note = notes[r.name.toLowerCase()] || {};
  const tech = (state.repoLangs[r.id] && state.repoLangs[r.id].slice(0, 4)) ||
    (r.language ? [r.language] : []);

  const links = el("span", { class: "r-proj-links" });
  links.appendChild(el("a", { href: r.html_url, text: "Code" }));
  let demo = (r.homepage || "").trim();
  if (demo) {
    if (!/^https?:\/\//.test(demo)) demo = "https://" + demo;
    links.appendChild(el("span", { text: " · " }));
    links.appendChild(el("a", { href: demo, text: "Live Demo" }));
  }

  const card = el("div", { class: "r-project" }, [
    el("div", { class: "r-proj-head" }, [
      el("span", { class: "r-proj-name", text: r.name }), links,
    ]),
    el("div", { class: "r-proj-meta", text: `★ ${(r.stargazers_count || 0).toLocaleString()}  ·  ⑂ ${(r.forks_count || 0).toLocaleString()}` }),
  ]);

  if (r.description) card.appendChild(el("div", { class: "r-proj-desc", text: r.description }));
  if (note.why) card.appendChild(el("div", { class: "r-proj-why", text: note.why }));
  if (note.bullets && note.bullets.length) {
    const ul = el("ul", { class: "r-proj-bullets" });
    for (const b of note.bullets) ul.appendChild(el("li", { text: b }));
    card.appendChild(ul);
  }
  if (tech.length) {
    card.appendChild(el("div", { class: "r-tech" }, [el("b", { text: "Tech: " }), tech.join(", ")]));
  }
  return card;
}

/* ============================================================
   SHARE CARD  (LeetCode-style year-in-review stats card)
   Renders a 1200×630 canvas from live GitHub data that the user
   can download as a PNG, copy to clipboard, or share. Replaces the
   old PDF export. Three self-contained colour themes (independent
   of the app's light/dark theme).
   ============================================================ */
let scTheme = "midnight";
let scAvatarImg = null;      // cached, CORS-clean avatar Image
let scAvatarUrl = "";        // url the cached avatar was loaded from

const SC_THEMES = {
  midnight: {
    bg: ["#0d1117", "#161b2e", "#1c1033"], glow: "rgba(163,113,247,.28)",
    text: "#f0f6fc", sub: "#9da7b3", tile: "rgba(255,255,255,.05)", tileBorder: "rgba(255,255,255,.10)",
    accent: "#a371f7", track: "rgba(255,255,255,.08)",
    heat: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
  },
  ocean: {
    bg: ["#04283b", "#05455e", "#066b6b"], glow: "rgba(56,189,248,.30)",
    text: "#eafcff", sub: "#a6d5df", tile: "rgba(255,255,255,.07)", tileBorder: "rgba(255,255,255,.13)",
    accent: "#38bdf8", track: "rgba(255,255,255,.10)",
    heat: ["#0b3a4a", "#0e5a5f", "#0f8a7e", "#22b8a6", "#5ce6d0"],
  },
  light: {
    bg: ["#ffffff", "#f2f5fb", "#e7edfb"], glow: "rgba(9,105,218,.16)",
    text: "#0d1117", sub: "#57606a", tile: "rgba(9,105,218,.06)", tileBorder: "rgba(9,105,218,.15)",
    accent: "#0969da", track: "rgba(9,105,218,.10)",
    heat: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
  },
};

const SC_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** roundRect polyfill-safe helper. */
function scRoundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Load the avatar (once per URL) then (re)draw the card. */
function renderShareCard() {
  const canvas = $("#shareCardCanvas");
  if (!canvas || !state.user) return;

  const url = state.user.avatar_url;
  if (url && url !== scAvatarUrl) {
    scAvatarUrl = url;
    scAvatarImg = null;
    const img = new Image();
    img.crossOrigin = "anonymous";                 // keep the canvas exportable
    img.onload = () => { scAvatarImg = img; drawShareCard(); };
    img.onerror = () => { scAvatarImg = null; drawShareCard(); };  // fall back to initials
    img.src = url;
  }
  drawShareCard();
}

function drawShareCard() {
  const canvas = $("#shareCardCanvas");
  if (!canvas || !state.user) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, P = 64;
  const t = SC_THEMES[scTheme] || SC_THEMES.midnight;
  const u = state.user;
  const fmt = (n) => Number(n || 0).toLocaleString();

  /* ---- background ---- */
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, t.bg[0]); g.addColorStop(0.55, t.bg[1]); g.addColorStop(1, t.bg[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W - 120, 90, 40, W - 120, 90, 520);
  glow.addColorStop(0, t.glow); glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  /* ---- header: avatar + name ---- */
  const acx = P + 62, acy = P + 58, ar = 62;
  ctx.save();
  ctx.beginPath(); ctx.arc(acx, acy, ar, 0, Math.PI * 2); ctx.closePath();
  ctx.lineWidth = 4; ctx.strokeStyle = t.accent; ctx.stroke();
  ctx.clip();
  if (scAvatarImg) {
    ctx.drawImage(scAvatarImg, acx - ar, acy - ar, ar * 2, ar * 2);
  } else {
    ctx.fillStyle = t.accent; ctx.fillRect(acx - ar, acy - ar, ar * 2, ar * 2);
    const initials = (u.name || u.login || "?").split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `800 46px ${SC_FONT}`; ctx.fillText(initials, acx, acy + 2);
  }
  ctx.restore();

  const subtitle = (state.username ? (loadResumeDetails(state.username).title || "") : "").trim();
  const tx = P + 158;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = t.text; ctx.font = `800 46px ${SC_FONT}`;
  ctx.fillText(u.name || u.login, tx, subtitle ? 104 : 112);
  ctx.fillStyle = t.sub; ctx.font = `500 27px ${SC_FONT}`;
  ctx.fillText("@" + u.login, tx, subtitle ? 144 : 154);
  if (subtitle) { ctx.fillStyle = t.accent; ctx.font = `600 22px ${SC_FONT}`; ctx.fillText(subtitle, tx, 180); }

  /* ---- stat tiles ---- */
  const totalStars = state.repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const { current } = computeStreaks(state.events);
  const tiles = [
    [fmt(u.public_repos ?? state.repos.length), "Repositories"],
    [fmt(totalStars), "Stars Earned"],
    [fmt(u.followers ?? 0), "Followers"],
    [`${fmt(current)} 🔥`, "Day Streak"],
  ];
  const tGap = 22, tTop = 224, tH = 116;
  const tW = (W - 2 * P - tGap * 3) / 4;
  tiles.forEach(([num, label], i) => {
    const x = P + i * (tW + tGap);
    ctx.fillStyle = t.tile; scRoundRect(ctx, x, tTop, tW, tH, 16); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = t.tileBorder; scRoundRect(ctx, x, tTop, tW, tH, 16); ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = t.text; ctx.font = `800 42px ${SC_FONT}`;
    ctx.fillText(String(num), x + tW / 2, tTop + 60);
    ctx.fillStyle = t.sub; ctx.font = `600 17px ${SC_FONT}`;
    ctx.fillText(label, x + tW / 2, tTop + 92);
  });

  /* ---- bottom-left: top languages ---- */
  const bTop = 400;
  ctx.textAlign = "left";
  ctx.fillStyle = t.text; ctx.font = `700 24px ${SC_FONT}`;
  ctx.fillText("Top Languages", P, bTop);

  const langEntries = Object.entries(state.languages).sort((a, b) => b[1] - a[1]);
  const langTotal = langEntries.reduce((s, [, b]) => s + b, 0) || 1;
  const barX = P + 132, barW = 300, barR = P + barW + 132 + 60;
  langEntries.slice(0, 4).forEach(([name, bytes], i) => {
    const y = bTop + 36 + i * 34;
    const pct = (bytes / langTotal) * 100;
    ctx.fillStyle = t.text; ctx.font = `600 18px ${SC_FONT}`; ctx.textAlign = "left";
    ctx.fillText(name.length > 12 ? name.slice(0, 11) + "…" : name, P, y);
    ctx.fillStyle = t.track; scRoundRect(ctx, barX, y - 13, barW, 12, 6); ctx.fill();
    ctx.fillStyle = langColor(name); scRoundRect(ctx, barX, y - 13, Math.max(6, barW * pct / 100), 12, 6); ctx.fill();
    ctx.fillStyle = t.sub; ctx.font = `600 16px ${SC_FONT}`; ctx.textAlign = "right";
    ctx.fillText(`${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`, barR, y);
  });
  if (!langEntries.length) {
    ctx.fillStyle = t.sub; ctx.font = `500 17px ${SC_FONT}`;
    ctx.fillText("No language data available.", P, bTop + 40);
  }

  /* ---- bottom-right: mini contribution heatmap ---- */
  const hx = 636, weeks = 30, cell = 13, cgap = 3, colW = cell + cgap;
  ctx.fillStyle = t.text; ctx.font = `700 24px ${SC_FONT}`; ctx.textAlign = "left";
  ctx.fillText("Contributions", hx, bTop);
  const map = buildPushMap(state.events);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks - 1) * 7);
  start.setDate(start.getDate() - start.getDay());
  const hTop = bTop + 22;
  let col = 0, row = 0;
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const lvl = heatLevel(map.get(ymd(d)) || 0);
    ctx.fillStyle = t.heat[lvl];
    scRoundRect(ctx, hx + col * colW, hTop + row * colW, cell, cell, 3); ctx.fill();
    row++;
    if (row === 7) { row = 0; col++; }
  }

  /* ---- footer ---- */
  ctx.fillStyle = t.sub; ctx.font = `600 19px ${SC_FONT}`; ctx.textAlign = "left";
  ctx.fillText(`github.com/${u.login}`, P, H - 40);
  ctx.textAlign = "right"; ctx.fillStyle = t.accent; ctx.font = `700 19px ${SC_FONT}`;
  ctx.fillText("DevFolio", W - P, H - 40);
}

/* ---- share-card wiring ---- */
$$(".sc-theme-pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    scTheme = pill.dataset.cardtheme || "midnight";
    $$(".sc-theme-pill").forEach((p) => {
      const on = p === pill;
      p.classList.toggle("active", on);
      p.setAttribute("aria-checked", String(on));
    });
    drawShareCard();
  });
});

/** Build the public shareable portfolio link for the current user. */
function shareCardLink() {
  const url = new URL(window.location.href);
  url.searchParams.set("user", state.username);
  return url.toString();
}

$("#scDownload").addEventListener("click", () => {
  const canvas = $("#shareCardCanvas");
  if (!canvas || !state.user) { toast("Generate a portfolio first."); return; }
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: `github-card-${state.user.login}.png` });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("Card downloaded");
  }, "image/png");
});

$("#scCopy").addEventListener("click", () => {
  const canvas = $("#shareCardCanvas");
  if (!canvas || !state.user) { toast("Generate a portfolio first."); return; }
  if (!navigator.clipboard || typeof window.ClipboardItem === "undefined") {
    toast("Image copy isn't supported here — use Download PNG.");
    return;
  }
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    try {
      await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
      flashButton($("#scCopy"), "✓ Copied!");
      toast("Card image copied to clipboard");
    } catch {
      toast("Couldn't copy image — use Download PNG instead.");
    }
  }, "image/png");
});

$("#scShareTwitter").addEventListener("click", () => {
  if (!state.user) { toast("Generate a portfolio first."); return; }
  const text = "Check out my GitHub developer card 🧑‍💻";
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareCardLink())}`;
  window.open(url, "_blank", "noopener");
  toast("Tip: use Download PNG to attach the card image");
});

$("#scShareLinkedin").addEventListener("click", () => {
  if (!state.user) { toast("Generate a portfolio first."); return; }
  const url = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareCardLink())}`;
  window.open(url, "_blank", "noopener");
  toast("Tip: use Download PNG to attach the card image");
});

/* ============================================================
   TOAST
   ============================================================ */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => { t.hidden = true; }, 250);
  }, 2200);
}

/* ============================================================
   INPUT: submit + URL param on load
   ============================================================ */
function debounce(fn, ms) {
  let h;
  return (...args) => { clearTimeout(h); h = setTimeout(() => fn(...args), ms); };
}

// Generate only on explicit submit (Enter key or Generate button click)
// to avoid burning API rate limit on every keystroke.

$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  generate($("#usernameInput").value);
});

// On load: ?user=username pre-fills + auto-generates.
window.addEventListener("DOMContentLoaded", () => {
  const user = new URLSearchParams(window.location.search).get("user");
  if (user) { $("#usernameInput").value = user; generate(user); }
});

// If Chart.js finishes loading after the data arrived, draw the chart once it's available.
window.addEventListener("load", () => {
  if (state.events.length && window.Chart && !state.chart) renderCommitChart(state.events);
});

/* ============================================================
   Shared backend-error mapper (used by the Tailor flow below).
   ============================================================ */
/** Map a backend failure into a friendly, user-facing message. */
function backendErrorMessage(kind, message, status) {
  if (kind === "config") return "The backend has no Gemini API key configured. Add GEMINI_API_KEY to backend/.env and restart the server.";
  if (kind === "notfound") return message || "No public repositories found for this user.";
  if (kind === "ratelimit") return message || "GitHub rate limit reached on the server. Set GITHUB_TOKEN in backend/.env.";
  if (kind === "input") return message || "Please check the job description and try again.";
  return message || `The backend returned an error${status ? ` (${status})` : ""}.`;
}

/* ============================================================
   BYOT — Bring Your Own Template  (Phase 5)
   Drop .tex template, paste JD, POST /api/resume/tailor,
   and see the injected result live in a CodeMirror editor.
   ============================================================ */
let byotEditor = null;        // CodeMirror instance
let byotLastLatex = "";       // latest injected result
const BYOT_MARKER = "% --- AI_PROJECTS_START --- %";

const BYOT_LOADING_STEPS = [
  "Fetching GitHub repositories…",
  "Analyzing job description…",
  "Matching projects with ATS keywords…",
  "Injecting tailored bullets into template…",
];

/** Lazy-init CodeMirror once its CDN finishes loading. */
function ensureByotEditor() {
  if (byotEditor) return byotEditor;
  if (typeof CodeMirror === "undefined") return null;

  const container = $("#byotEditor");
  if (!container) return null;

  byotEditor = CodeMirror(container, {
    value: "",
    mode: "stex",
    theme: "material-darker",
    lineNumbers: true,
    matchBrackets: true,
    viewportMargin: 20,
    lineWrapping: false,
  });

  // After a paste/edit, re-check markers silently
  byotEditor.on("change", () => {
    if (byotEditor) $("#byotMarkerWarn").hidden = byotHasMarkers(byotEditor.getValue());
  });

  return byotEditor;
}

/** True if a template contains BOTH project markers (the required pair). */
function byotHasMarkers(text) {
  return String(text).includes("% --- AI_PROJECTS_START --- %") &&
    String(text).includes("% --- AI_PROJECTS_END --- %");
}

/* ---- Step 2 tabs: "Upload .tex File"  |  "Paste LaTeX Code" ----
   Both tabs feed the SAME CodeMirror instance (single source of truth):
   the upload dropzone fills it, the paste tab shows it for direct editing. */
function switchByotTab(which) {
  const upload = which === "upload";
  $("#byotTabUpload").classList.toggle("active", upload);
  $("#byotTabPaste").classList.toggle("active", !upload);
  $("#byotTabUpload").setAttribute("aria-selected", String(upload));
  $("#byotTabPaste").setAttribute("aria-selected", String(!upload));
  $("#byotPanelUpload").hidden = !upload;
  $("#byotPanelPaste").hidden = upload;
  // CodeMirror renders blank if it was created inside a hidden panel — refresh on show.
  if (!upload) { const ed = ensureByotEditor(); if (ed) setTimeout(() => ed.refresh(), 0); }
}

/** A minimal, compilable starter template with the project markers in place. */
const BYOT_STARTER_TEMPLATE = [
  "\\documentclass[letterpaper,11pt]{article}",
  "\\usepackage[margin=1in]{geometry}",
  "\\usepackage{enumitem}",
  "\\usepackage{hyperref}",
  "",
  "\\begin{document}",
  "",
  "% ==================== HEADER (never edited by the AI) ====================",
  "\\begin{center}",
  "  {\\Large \\textbf{Your Name}} \\\\",
  "  \\small your.email@example.com $|$ +1 555 0123 $|$ linkedin.com/in/you $|$ github.com/you",
  "\\end{center}",
  "",
  "% ==================== EDUCATION (never edited by the AI) ====================",
  "\\section*{Education}",
  "\\textbf{Your University} \\hfill Graduation Year \\\\",
  "Your Degree \\hfill GPA: X.X / 10",
  "",
  "% ==================== SKILLS (never edited by the AI) ====================",
  "\\section*{Technical Skills}",
  "Languages, frameworks, and tools you know.",
  "",
  "% ==================== PROJECTS ====================",
  "\\section*{Projects}",
  "\\begin{itemize}[leftmargin=*]",
  "% --- AI_PROJECTS_START --- %",
  "  \\item Your tailored projects will be injected here, matched to the job description.",
  "% --- AI_PROJECTS_END --- %",
  "\\end{itemize}",
  "",
  "\\end{document}",
  "",
].join("\n");

/** Reset the BYOT state when a new username is searched.
 *  IMPORTANT: keeps the CodeMirror content (uploaded template) intact. */
function resetByotState() {
  const jd = $("#byotJD");
  if (jd) jd.value = "";
  $("#byotError").hidden = true;
  $("#byotResult").hidden = true;
  $("#byotDetails").hidden = true;
  stopByotLoading();
  byotLastLatex = "";
}

/** Stop the BYOT loader and clean up. */
function stopByotLoadingInternal() {
  clearInterval(window._byotTimer);
  window._byotTimer = null;
  $("#byotLoading").hidden = true;
  $("#byotGenerateBtn").disabled = false;
}
function startByotLoading() {
  $("#byotError").hidden = true;
  $("#byotResult").hidden = true;
  $("#byotDetails").hidden = true;
  $("#byotLoading").hidden = false;
  $("#byotGenerateBtn").disabled = true;

  let i = 0;
  const text = $("#byotLoadingText");
  text.textContent = BYOT_LOADING_STEPS[0];
  clearInterval(window._byotTimer);
  window._byotTimer = setInterval(() => {
    i = (i + 1) % BYOT_LOADING_STEPS.length;
    text.textContent = BYOT_LOADING_STEPS[i];
  }, 1800);
}
function stopByotLoading() { stopByotLoadingInternal(); }

/** Show inline error in the BYOT section. */
function showByotError(msg) {
  const node = $("#byotError");
  node.textContent = msg;
  node.hidden = false;
  stopByotLoading();
}

/* ---- drop zone wiring ---- */
function setupByotDropzone() {
  const zone = $("#byotDropzone");
  const input = $("#byotFileInput");
  if (!zone || !input) return;

  // click → file picker
  zone.addEventListener("click", () => input.click());

  // drag/drop
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    readTemplateFile(files[0]);
  });

  // file input change
  input.addEventListener("change", () => {
    const files = input.files;
    if (files && files.length) readTemplateFile(files[0]);
    input.value = "";  // allow re-picking the same file
  });
}

/** FileReader.readAsText, populate CodeMirror, check markers. */
function readTemplateFile(file) {
  if (!file) return;
  if (!/\.(tex|txt)$/i.test(file.name)) {
    toast("Please upload a .tex or .txt file.");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    const editor = ensureByotEditor();
    if (!editor) {
      // CodeMirror hasn't loaded yet — retry shortly
      setTimeout(() => readTemplateFile(file), 300);
      return;
    }
    editor.setValue(text);
    switchByotTab("paste");   // reveal the editor so the user sees the loaded template
    editor.refresh();

    // marker check (both markers required)
    const hasMarkers = byotHasMarkers(text);
    $("#byotMarkerWarn").hidden = hasMarkers;
    if (!hasMarkers) toast("Template is missing the project injection markers.");
  };
  reader.onerror = () => toast("Could not read the file. Try again.");
  reader.readAsText(file, "UTF-8");
}

/** Submit the BYOT form: JD + template → POST /api/resume/tailor. */
async function generateByotTailor() {
  const editor = ensureByotEditor();
  if (!editor) { toast("CodeMirror hasn't loaded yet — wait a moment and try again."); return; }
  if (!state.username) { toast("Generate a portfolio first."); return; }

  const latexTemplate = editor.getValue();
  if (!latexTemplate.trim()) { toast("Upload or paste your LaTeX template first."); return; }
  if (!latexTemplate.includes(BYOT_MARKER)) {
    showByotError(`Template is missing the project marker "${BYOT_MARKER}". Add it to your template and try again.`);
    return;
  }
  const jobDescription = $("#byotJD").value.trim();
  if (!jobDescription) { toast("Paste a job description first."); $("#byotJD").focus(); return; }

  startByotLoading();
  try {
    let res;
    try {
      res = await fetch(`${BACKEND_URL}/api/resume/tailor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          github_username: state.username,
          job_description: jobDescription,
          latex_template: latexTemplate,
        }),
      });
    } catch {
      const err = new Error(`Couldn't reach the backend at ${BACKEND_URL}. Is the server running (npm start in backend/)?`);
      err._friendly = err.message;
      throw err;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { _friendly: backendErrorMessage(data.kind, data.error, res.status) };

    renderByotResult(data);
    toast("Projects injected into template");
  } catch (err) {
    showByotError(err && err._friendly ? err._friendly : "Something went wrong injecting the template.");
  } finally {
    stopByotLoading();
  }
}

/** Highlight lines between the project markers in CodeMirror. */
function highlightInjectedLines(editor, newTex, oldTex) {
  // Clear previous highlights
  const doc = editor.getDoc();
  for (let i = 0; i < doc.lineCount(); i++) {
    doc.removeLineClass(i, "background", "cm-injected");
  }

  // Find the project marker lines in the NEW text and highlight them
  const lines = newTex.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("% --- AI_PROJECTS_START --- %")) {
      doc.addLineClass(i, "background", "cm-injected");
      inBlock = true;
      continue;
    }
    if (line.includes("% --- AI_PROJECTS_END --- %")) {
      doc.addLineClass(i, "background", "cm-injected");
      inBlock = false;
      continue;
    }
    if (inBlock) doc.addLineClass(i, "background", "cm-injected");
    // Projects-only: the skills region is never modified, so it is never highlighted.
  }
}

/** Render the BYOT result: update CodeMirror + show details + result bar. */
function renderByotResult(data) {
  byotLastLatex = data.latex || "";

  // Update CodeMirror with the injected LaTeX (Step 4 output view)
  const editor = ensureByotEditor();
  if (editor) {
    const oldVal = editor.getValue();
    editor.setValue(byotLastLatex);
    switchByotTab("paste");   // reveal the editor so the tailored .tex is visible
    editor.refresh();
    highlightInjectedLines(editor, byotLastLatex, oldVal);
  }

  // Result bar — reveal
  $("#byotResult").hidden = false;

  // Projects in the tailored résumé (kept / replaced / added)
  const projects = $("#byotProjects");
  projects.replaceChildren();
  for (const p of data.selectedProjects || []) {
    const action = (p.action || "kept").toLowerCase();
    projects.appendChild(el("li", { class: "ai-proj" }, [
      el("div", { class: "ai-proj-name" }, [
        el("span", { text: p.name || "Untitled" }),
        el("span", { class: `byot-action byot-action-${action}`, text: action }),
      ]),
      p.reason ? el("div", { class: "ai-proj-reason", text: p.reason }) : null,
    ]));
  }
  if (!projects.childNodes.length) projects.appendChild(el("li", { text: "No projects returned." }));

  // Skills to add
  const add = $("#byotSkillsAdd");
  add.replaceChildren();
  if ((data.skillsToAdd || []).length) {
    for (const s of data.skillsToAdd) add.appendChild(el("span", { class: "ai-chip ai-chip-add", text: s }));
  } else {
    add.appendChild(el("span", { class: "hint", text: "— none —" }));
  }

  // Skills to remove
  const remove = $("#byotSkillsRemove");
  remove.replaceChildren();
  if ((data.skillsToRemove || []).length) {
    for (const s of data.skillsToRemove) remove.appendChild(el("span", { class: "ai-chip ai-chip-remove", text: s }));
  } else {
    remove.appendChild(el("span", { class: "hint", text: "— none —" }));
  }

  // Warnings
  const warnings = $("#byotWarnings");
  warnings.replaceChildren();
  if ((data.warnings || []).length) {
    for (const w of data.warnings) warnings.appendChild(el("li", { text: w }));
  } else {
    warnings.appendChild(el("li", { class: "hint", text: "No warnings — only the projects region changed." }));
  }

  // Considered repos (with README indicator)
  const considered = $("#byotConsidered");
  considered.replaceChildren();
  for (const r of data.consideredRepos || []) {
    const readme = r.hasReadme ? "  ✓ README" : "  ✗ no README";
    considered.appendChild(el("li", { text: `${r.name}  ★${r.stargazers ?? 0}${readme}` }));
  }

  $("#byotDetails").hidden = false;
  $("#byotSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---- wiring: tabs + starter + drop zone + submit + copy/download ---- */
setupByotDropzone();

// Step 2 tab toggle
$("#byotTabUpload").addEventListener("click", () => switchByotTab("upload"));
$("#byotTabPaste").addEventListener("click", () => switchByotTab("paste"));

// "Insert starter template" — drop a marker-ready template into the editor
$("#byotStarterLink").addEventListener("click", () => {
  const editor = ensureByotEditor();
  if (!editor) { toast("Editor is still loading — try again in a moment."); return; }
  editor.setValue(BYOT_STARTER_TEMPLATE);
  switchByotTab("paste");
  editor.refresh();
  $("#byotMarkerWarn").hidden = true;
  toast("Starter template inserted — edit your header/education, then Generate.");
});

$("#byotGenerateBtn").addEventListener("click", () => { generateByotTailor(); });

$("#byotCopyBtn").addEventListener("click", async () => {
  if (!byotLastLatex) return;
  try {
    await navigator.clipboard.writeText(byotLastLatex);
    flashButton($("#byotCopyBtn"), "✓ Copied!");
    toast("LaTeX copied to clipboard");
  } catch {
    window.prompt("Copy the LaTeX source:", byotLastLatex);
  }
});

$("#byotDownloadBtn").addEventListener("click", () => {
  if (!byotLastLatex) return;
  const blob = new Blob([byotLastLatex], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: "tailored-resume.tex" });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Downloaded tailored-resume.tex");
});

// Init CodeMirror on page load (poll until CDN arrives, with max retries)
(function initCodemirrorPoll(attempt) {
  attempt = attempt || 0;
  const MAX_POLL = 30; // ~4.5 seconds
  const editor = ensureByotEditor();
  if (editor) {
    editor.setValue(""); // ready
  } else if (typeof CodeMirror === "undefined" && attempt < MAX_POLL) {
    setTimeout(() => initCodemirrorPoll(attempt + 1), 150);
  }
  // If CDN never loads, the editor area stays inert — user can still upload/paste.
})();

/* ============================================================
   SCROLL REVEAL  (fade-in-up)
   Adds the .fade-in-up class to portfolio panels + stat cards,
   then flips them to .in as they scroll into view. Idempotent:
   already-tagged elements are skipped, so it's safe to call on
   every generate.
   ============================================================ */
function revealOnScroll() {
  const targets = document.querySelectorAll(
    "#portfolio .panel, #portfolio .stat-card"
  );
  if (!("IntersectionObserver" in window)) {
    // No IO support — just show everything.
    targets.forEach((el) => el.classList.add("fade-in-up", "in"));
    return;
  }
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("in");
      obs.unobserve(entry.target);
    });
  }, { threshold: 0.12 });

  targets.forEach((el, i) => {
    if (el.classList.contains("fade-in-up")) return;   // already handled
    el.classList.add("fade-in-up");
    el.style.animationDelay = Math.min(i * 60, 400) + "ms";
    io.observe(el);
  });
}
