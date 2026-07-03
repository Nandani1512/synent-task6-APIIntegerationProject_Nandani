/* ============================================================
   JD -> LaTeX Resume Matcher — src/github.js
   Server-side GitHub fetch layer (used by the pipeline).

   Mirrors the frontend's fetch approach but runs on the server so an
   optional GITHUB_TOKEN (5,000 req/hr) never reaches the browser.
   Returns normalized GithubRepoMetadata[] ready for the prefilter.
   ============================================================ */
"use strict";

const { toRepoMetadata } = require("./models");

const GH_API = "https://api.github.com";

/** Typed error so the controller can map kinds to HTTP statuses. */
class GHError extends Error {
  /** @param {'notfound'|'ratelimit'|'network'|'http'|'input'|'config'} kind */
  constructor(kind, message, status) {
    super(message);
    this.name = "GHError";
    this.kind = kind;
    this.status = status;
  }
}

function ghHeaders(token) {
  const h = { Accept: "application/vnd.github+json", "User-Agent": "devfolio-resume-backend" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * GET a GitHub REST path, returning parsed JSON. Throws GHError on failure.
 *
 * @param {string} path  e.g. "/users/octocat/repos?per_page=100"
 * @param {{ token?: string, fetchImpl?: typeof fetch }} deps
 */
async function ghGet(path, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await fetchImpl(`${GH_API}${path}`, { headers: ghHeaders(deps.token) });
  } catch (err) {
    throw new GHError("network", `Network error contacting GitHub: ${err.message}`, 0);
  }

  if (res.ok) return res.json();

  if (res.status === 404) throw new GHError("notfound", "GitHub user or repository not found.", 404);
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers && res.headers.get && res.headers.get("X-RateLimit-Remaining");
    if (remaining === "0") {
      throw new GHError("ratelimit", "GitHub API rate limit reached. Set GITHUB_TOKEN to raise it to 5,000/hr.", res.status);
    }
    throw new GHError("http", `GitHub access forbidden (${res.status}).`, res.status);
  }
  throw new GHError("http", `GitHub returned an unexpected status (${res.status}).`, res.status);
}

/**
 * Fetch a user's public repos as normalized metadata. To respect the rate
 * limit, the per-repo language byte map is only fetched for the top
 * `langLimit` repos (by stars); the rest fall back to their primary language.
 * Forks are excluded by default (own work is what matters on a resume).
 *
 * @param {string} username
 * @param {{ token?: string, fetchImpl?: typeof fetch, langLimit?: number, includeForks?: boolean }} [opts]
 * @returns {Promise<import('./models').GithubRepoMetadata[]>}
 */
async function getReposForUser(username, opts = {}) {
  const token = opts.token || process.env.GITHUB_TOKEN || "";
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const langLimit = Number.isFinite(opts.langLimit) ? opts.langLimit : 15;
  const includeForks = !!opts.includeForks;

  const name = String(username || "").trim().replace(/^@/, "");
  if (!name) throw new GHError("input", "GitHub username is required.", 400);
  if (typeof fetchImpl !== "function") throw new GHError("config", "No fetch implementation (need Node 18+).", 500);

  const reposRaw = await ghGet(`/users/${encodeURIComponent(name)}/repos?per_page=100&sort=updated`, { token, fetchImpl });
  const list = Array.isArray(reposRaw) ? reposRaw : [];
  const owned = includeForks ? list : list.filter((r) => !r.fork);

  // Fetch language maps for the most-starred repos only.
  const targets = [...owned]
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
    .slice(0, langLimit);

  const langMaps = await Promise.all(
    targets.map((r) =>
      ghGet(`/repos/${r.owner.login}/${encodeURIComponent(r.name)}/languages`, { token, fetchImpl })
        .catch(() => ({})) // one failed repo must not sink the whole request
    )
  );
  const langById = new Map(targets.map((r, i) => [r.id, langMaps[i]]));

  return owned.map((r) => toRepoMetadata(r, langById.get(r.id)));
}

/**
 * Fetch a repo's README as raw text ("" if none / on any error — a missing
 * README must never sink the request). Uses the raw media type so we get
 * plain Markdown instead of a base64 blob.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {{ token?: string, fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<string>}
 */
async function fetchReadme(owner, repo, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return "";
  try {
    const res = await fetchImpl(
      `${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
      { headers: { ...ghHeaders(deps.token), Accept: "application/vnd.github.raw+json" } }
    );
    if (!res.ok) return "";
    return String(await res.text());
  } catch {
    return "";
  }
}

/**
 * Attach a `readme` field to each repo by fetching it in parallel. Only the
 * given repos are fetched (callers pass the top-ranked candidates to bound
 * the number of API calls).
 *
 * @param {string} owner
 * @param {import('./models').GithubRepoMetadata[]} repos
 * @param {{ token?: string, fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<Array<import('./models').GithubRepoMetadata & { readme: string }>>}
 */
async function attachReadmes(owner, repos, deps = {}) {
  const list = Array.isArray(repos) ? repos : [];
  const readmes = await Promise.all(list.map((r) => fetchReadme(owner, r.name, deps)));
  return list.map((r, i) => ({ ...r, readme: readmes[i] }));
}

module.exports = { GHError, ghGet, getReposForUser, fetchReadme, attachReadmes };
