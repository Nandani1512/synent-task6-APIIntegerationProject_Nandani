/* ============================================================
   GitHub Dev Portfolio Generator — script.js
   Phase 1: fetch layer, hero section, theme, debounced input.
   Vanilla JS, Fetch API, Promise.all, sessionStorage.
   ============================================================ */
"use strict";

/* ---------- constants ---------- */
const API = "https://api.github.com";
const TOKEN_KEY = "ghpf_token";
const LANG_FETCH_LIMIT = 8;      // cap per-repo language calls to protect the 60/hr rate limit
const TOP_LANGS = 8;             // skill bars to show
const PIN_KEY = (u) => `ghpf_pins_${u.toLowerCase()}`;
const CACHE_KEY = (u) => `ghpf_cache_${u.toLowerCase()}`;

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

/** Escape any user-derived string before it is ever interpolated into markup. */
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* ---------- app state ---------- */
const state = {
  username: "",
  user: null,
  repos: [],
  languages: {},   // { lang: bytes }
  pins: new Set(),
};

/* ============================================================
   THEME (CSS-variable based dark / light toggle)
   ============================================================ */
(function initTheme() {
  const saved = sessionStorage.getItem("ghpf_theme");
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
  sessionStorage.setItem("ghpf_theme", next);
  syncThemeIcon();
});

/* ============================================================
   TOKEN HANDLING (raises rate limit 60 -> 5000)
   Stored in sessionStorage; UI to manage it is added in Phase 5.
   ============================================================ */
function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ""; }

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

  if (res.ok) return res.json();

  if (res.status === 404) throw new GHError("notfound", "User not found.", 404);
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("X-RateLimit-Remaining");
    if (remaining === "0") throw new GHError("ratelimit", "GitHub API rate limit reached.", res.status);
    throw new GHError("http", "Access forbidden by GitHub (403).", res.status);
  }
  throw new GHError("http", `GitHub returned an unexpected status (${res.status}).`, res.status);
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
    // --- PARALLEL fetch with Promise.all (more endpoints added in later phases) ---
    const [user, repos] = await Promise.all([
      ghFetch(`/users/${encodeURIComponent(username)}`),
      ghFetch(`/users/${encodeURIComponent(username)}/repos?sort=stars&per_page=100`),
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
    for (const map of langResults) {
      for (const [lang, bytes] of Object.entries(map)) {
        languages[lang] = (languages[lang] || 0) + bytes;
      }
    }
    // fall back to the primary `language` field for repos beyond the cap
    for (const r of repos.slice(LANG_FETCH_LIMIT)) {
      if (r.language) languages[r.language] = (languages[r.language] || 0) + 1;
    }

    const data = { user, repos, languages };
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
  state.pins = loadPins(username);

  $("#portfolio").hidden = false;
  renderHero(data.user);
  renderStats(data.user, data.repos);
  renderSkills(data.languages);
  renderRepos(data.repos);
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

/** Count up from 0 to target with an easeOutCubic curve. */
function animateCounter(node, target) {
  target = Number(target) || 0;
  const duration = 900;
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = Math.round(eased * target).toLocaleString();
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

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
    text: isPinned ? "📌" : "📍",
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
   LOADING / ERROR STATES
   ============================================================ */
function showSkeleton(on) {
  $("#heroSkeleton").hidden = !on;
  if (on) { $("#heroCard").hidden = true; $("#portfolio").hidden = true; }
  $("#generateBtn").disabled = on;
  $("#generateBtn").textContent = on ? "Loading…" : "Generate";
}

function showError(err) {
  const panel = $("#errorPanel");
  const kind = err instanceof GHError ? err.kind : "http";

  const presets = {
    notfound:  { icon: "🔍", title: "User not found", msg: `No GitHub user named “${state.username}”. Check the spelling and try again.` },
    ratelimit: { icon: "⏳", title: "Rate limit reached", msg: "You've hit GitHub's unauthenticated limit (60/hour). A personal access token (added in a later phase) raises it to 5,000/hour." },
    network:   { icon: "📡", title: "Network error", msg: "Couldn't reach GitHub. Check your internet connection and retry." },
    http:      { icon: "⚠️", title: "Something went wrong", msg: err.message || "An unexpected error occurred." },
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
  if (state.username) generate(state.username);
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
   INPUT: debounced + submit + URL param on load
   ============================================================ */
function debounce(fn, ms) {
  let h;
  return (...args) => { clearTimeout(h); h = setTimeout(() => fn(...args), ms); };
}

// Debounced auto-generate as the user types (300ms) — prevents API spam.
const debouncedGenerate = debounce((value) => {
  const v = value.trim();
  if (v.length >= 2) generate(v);
}, 300);

$("#usernameInput").addEventListener("input", (e) => debouncedGenerate(e.target.value));

$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  generate($("#usernameInput").value);
});

// On load: ?user=username pre-fills + auto-generates.
window.addEventListener("DOMContentLoaded", () => {
  const user = new URLSearchParams(window.location.search).get("user");
  if (user) { $("#usernameInput").value = user; generate(user); }
});
