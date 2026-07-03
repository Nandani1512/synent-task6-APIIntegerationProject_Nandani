/* ============================================================
   JD -> LaTeX Resume Matcher — src/prefilter.js  (Phase 1)
   Lightweight, dependency-free JD -> repo matcher.

   Cheaply narrows a user's repos to the ~7 most JD-relevant BEFORE
   we spend an LLM call. Pure heuristics (tokenization + keyword
   frequency + weighted field matching) — instant and unit-testable.
   ============================================================ */
"use strict";

/* ------------------------------------------------------------ Config */
const DEFAULT_LIMIT = 7;

// A JD keyword found in a repo's language list is a far stronger signal
// than the same word buried in prose.
const FIELD_WEIGHTS = { languages: 4, topics: 3, name: 3, description: 1 };

// Small nudge so an actively-maintained match outranks an equally-scored
// stale one (only ever acts as a tie-breaker among matched repos).
const RECENCY_BONUS = 0.5;
const RECENCY_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "with", "you", "your", "our", "will", "have",
  "has", "had", "this", "that", "these", "those", "from", "into", "out",
  "who", "what", "which", "when", "where", "how", "why", "all", "any",
  "can", "may", "should", "must", "would", "could", "able", "ability",
  "work", "working", "experience", "experiences", "year", "years",
  "team", "teams", "role", "roles", "job", "company", "candidate",
  "candidates", "looking", "seeking", "join", "help", "build", "building",
  "strong", "good", "great", "excellent", "plus", "etc", "including",
  "knowledge", "skills", "skill", "understanding", "familiar", "familiarity",
  "responsibilities", "requirements", "qualifications", "preferred",
  "required", "responsible", "develop", "developing", "development",
  "design", "designing", "using", "use", "used", "across", "within",
  "about", "their", "they", "them", "than", "such", "well", "more",
  "nice", "we", "us", "to", "of", "in", "on", "at", "as", "by", "be",
  "is", "it", "or", "if", "do", "an",
]);

// Tokens that denote a demanded *technical* skill. Lowercase. Used to keep
// short tech tokens (e.g. "go", "ml") that the generic length filter drops,
// and to populate JobDescriptionProfile.technicalSkillsDemanded.
const TECH_TOKENS = new Set([
  "javascript", "typescript", "python", "java", "kotlin", "swift", "go",
  "golang", "rust", "ruby", "php", "c", "c++", "c#", "scala", "elixir",
  "dart", "html", "css", "sass", "scss", "tailwind", "bootstrap",
  "react", "react.js", "reactjs", "vue", "vue.js", "angular", "svelte",
  "next.js", "nextjs", "nuxt", "redux", "jquery",
  "node", "node.js", "nodejs", "express", "express.js", "nestjs", "deno",
  "django", "flask", "fastapi", "spring", "rails", "laravel", ".net",
  "dotnet", "asp.net", "graphql", "rest", "restful", "grpc", "websocket",
  "websockets", "api", "apis",
  "mongodb", "mongo", "mysql", "postgresql", "postgres", "sqlite",
  "redis", "firebase", "supabase", "dynamodb", "sql", "nosql", "prisma",
  "aws", "azure", "gcp", "docker", "kubernetes", "k8s", "terraform",
  "ci", "cd", "ci/cd", "jenkins", "github", "gitlab", "git", "linux",
  "nginx", "serverless", "lambda",
  "tensorflow", "pytorch", "keras", "pandas", "numpy", "scikit-learn",
  "sklearn", "ml", "ai", "nlp", "opencv",
  "android", "ios", "flutter", "react-native", "reactnative",
  "jest", "mocha", "cypress", "playwright", "selenium", "webpack", "vite",
]);

/* ------------------------------------------------------------ Tokenization */

/**
 * Lowercase + split on runs of non-token chars, deliberately PRESERVING
 * punctuation meaningful inside tech names: `+` (c++), `#` (c#),
 * `.` (node.js, .net), `/` (ci/cd), `-` (scikit-learn). Edge punctuation
 * is trimmed; pure 1-char noise dropped (except "c").
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9+#./-]+/)
    .map((t) => t.replace(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter((t) => t.length >= 2 || t === "c");
}

/** True if a token carries signal worth keeping as a keyword. */
function isSignal(token) {
  if (!token) return false;
  if (STOPWORDS.has(token)) return false;
  if (TECH_TOKENS.has(token)) return true;
  return token.length >= 3 && !/^\d+$/.test(token);
}

/* ------------------------------------------------------------ JD profiling */

/**
 * Frequency-ranked keyword map from raw JD text (signal words only).
 *
 * @param {string} jdText
 * @returns {Map<string, number>}
 */
function keywordCounts(jdText) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const tok of tokenize(jdText)) {
    if (!isSignal(tok)) continue;
    counts.set(tok, (counts.get(tok) || 0) + 1);
  }
  return counts;
}

/**
 * Cheap best-guess role title from the JD.
 *
 * @param {string} jdText
 * @param {Map<string, number>} counts
 * @returns {string}
 */
function guessPrimaryRole(jdText, counts) {
  const text = String(jdText || "").toLowerCase();
  const seniorities = ["senior", "lead", "principal", "staff", "junior", "entry-level", "intern"];
  const roles = [
    ["full stack", "Full Stack Developer"], ["full-stack", "Full Stack Developer"],
    ["front end", "Frontend Developer"], ["frontend", "Frontend Developer"], ["front-end", "Frontend Developer"],
    ["back end", "Backend Developer"], ["backend", "Backend Developer"], ["back-end", "Backend Developer"],
    ["devops", "DevOps Engineer"], ["data scientist", "Data Scientist"], ["data engineer", "Data Engineer"],
    ["machine learning", "Machine Learning Engineer"], ["mobile", "Mobile Developer"],
    ["android", "Android Developer"], ["ios", "iOS Developer"],
    ["software engineer", "Software Engineer"], ["software developer", "Software Developer"],
    ["web developer", "Web Developer"],
  ];

  let baseRole = "";
  for (const [needle, label] of roles) {
    if (text.includes(needle)) { baseRole = label; break; }
  }
  if (!baseRole) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0].replace(/\b\w/g, (c) => c.toUpperCase()) : "Software Developer";
  }

  const seniority = seniorities.find((s) => text.includes(s));
  if (seniority && !/intern|entry/.test(seniority)) {
    return `${seniority.replace(/\b\w/g, (c) => c.toUpperCase())} ${baseRole}`;
  }
  return baseRole;
}

/**
 * Build a JobDescriptionProfile (Phase-1 heuristic view of the JD).
 *
 * @param {string} jdText
 * @returns {import('./models').JobDescriptionProfile}
 */
function profileJobDescription(jdText) {
  const counts = keywordCounts(jdText);
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);

  return {
    extractedKeywords: ranked,
    primaryRole: guessPrimaryRole(jdText, counts),
    technicalSkillsDemanded: ranked.filter((k) => TECH_TOKENS.has(k)),
  };
}

/* ------------------------------------------------------------ Scoring */

/**
 * Score a repo against the JD keyword-frequency map. For every JD keyword
 * present in a repo field, add (jdFrequency × fieldWeight). A keyword counts
 * once per field but can score across multiple fields.
 *
 * @param {import('./models').GithubRepoMetadata} repo
 * @param {Map<string, number>} counts
 * @param {number} now  epoch ms (injectable for tests)
 * @returns {{ score: number, matchedKeywords: string[] }}
 */
function scoreRepo(repo, counts, now) {
  const fields = {
    name: new Set(tokenize(repo.name)),
    description: new Set(tokenize(repo.description)),
    languages: new Set(repo.languages.flatMap(tokenize)),
    topics: new Set(repo.topics.flatMap(tokenize)),
  };

  let score = 0;
  const matched = new Set();
  for (const [keyword, freq] of counts) {
    for (const field of Object.keys(FIELD_WEIGHTS)) {
      if (fields[field].has(keyword)) {
        score += freq * FIELD_WEIGHTS[field];
        matched.add(keyword);
      }
    }
  }

  if (score > 0 && repo.updatedAt) {
    const ts = Date.parse(repo.updatedAt);
    if (Number.isFinite(ts) && now - ts <= RECENCY_WINDOW_MS) score += RECENCY_BONUS;
  }

  return { score, matchedKeywords: [...matched] };
}

/* ------------------------------------------------------------ Ranking API */

/**
 * Rank repos against a JD, richest-first, with score + matched keywords
 * attached (useful for UI "why this repo" transparency).
 *
 * @param {import('./models').GithubRepoMetadata[]} repos
 * @param {string} jdText
 * @param {{ now?: number }} [opts]
 * @returns {{ repo: import('./models').GithubRepoMetadata, score: number, matchedKeywords: string[] }[]}
 */
function rankRepos(repos, jdText, opts) {
  const list = Array.isArray(repos) ? repos : [];
  const counts = keywordCounts(jdText);
  const now = opts && opts.now != null ? opts.now : Date.now();

  return list
    .map((repo) => {
      const { score, matchedKeywords } = scoreRepo(repo, counts, now);
      return { repo, score, matchedKeywords };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.repo.stargazers - a.repo.stargazers ||
        (Date.parse(b.repo.updatedAt) || 0) - (Date.parse(a.repo.updatedAt) || 0)
    );
}

/**
 * Pre-filter: return the top-N most JD-relevant repos. If nothing matches
 * (empty/garbled JD), fall back to most-starred so the pipeline still has
 * reasonable input.
 *
 * @param {import('./models').GithubRepoMetadata[]} repos
 * @param {string} jdText
 * @param {number} [limit=7]
 * @param {{ now?: number }} [opts]
 * @returns {import('./models').GithubRepoMetadata[]}
 */
function prefilterRepos(repos, jdText, limit, opts) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
  const ranked = rankRepos(repos, jdText, opts);

  const matched = ranked.filter((r) => r.score > 0);
  const chosen = matched.length
    ? matched
    : ranked.slice().sort((a, b) => b.repo.stargazers - a.repo.stargazers);

  return chosen.slice(0, n).map((r) => r.repo);
}

module.exports = {
  tokenize,
  keywordCounts,
  profileJobDescription,
  scoreRepo,
  rankRepos,
  prefilterRepos,
  config: { DEFAULT_LIMIT, FIELD_WEIGHTS, RECENCY_BONUS, RECENCY_WINDOW_MS },
};
