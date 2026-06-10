/* ============================================================
   GitHub Dev Portfolio Generator — script.js
   Phase 1: fetch layer, hero section, theme, debounced input.
   Vanilla JS, Fetch API, Promise.all, sessionStorage.
   ============================================================ */
"use strict";

/* ---------- constants ---------- */
const API = "https://api.github.com";
const TOKEN_KEY = "ghpf_token";

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

  try {
    // Parallel fetch with Promise.all (more endpoints are added in later phases).
    const [user] = await Promise.all([
      ghFetch(`/users/${encodeURIComponent(username)}`),
    ]);

    state.user = user;
    renderHero(user);
  } catch (err) {
    showError(err);
  } finally {
    showSkeleton(false);
  }
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
   LOADING / ERROR STATES
   ============================================================ */
function showSkeleton(on) {
  $("#heroSkeleton").hidden = !on;
  if (on) $("#heroCard").hidden = true;
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
