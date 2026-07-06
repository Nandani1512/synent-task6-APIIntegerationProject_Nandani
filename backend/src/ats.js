/* ============================================================
   JD -> LaTeX Resume Matcher — src/ats.js  (Phase 2, BYOT flow)
   README-aware, format-preserving projects-region rewriter (Gemini).

   Used by the *Bring Your Own Template* pipeline (POST /api/resume/
   tailor). It reuses the exact Gemini transport (callGeminiOnce) from
   llm.js but supplies its own system prompt + response schema.

   Given the candidate's ORIGINAL projects region (the LaTeX between the
   AI_PROJECTS markers), the Job Description, and the top pre-filtered
   GitHub repos (each WITH its README), it asks Gemini — acting as an
   expert technical recruiter — to:
     - KEEP the original projects that are relevant to the JD, verbatim,
     - REPLACE only the ones that are weak/irrelevant with a more
       JD-relevant repo, but ONLY when that repo's README is detailed
       enough to ground specific bullets (the model judges this),
     - keep the TOTAL project count the same as the original,
     - format any replacement to EXACTLY match the surrounding LaTeX
       style / spacing so the document reads as one consistent template,
     - wrap JD-matching keywords in \textbf{...} so they stand out, and
     - suggest skills to ADD and to REMOVE for this JD.

   Output is forced (responseSchema / JSON mode) into:
     {
       projects_latex:   string,     // the full region, user's format
       skills_to_add:    string[],
       skills_to_remove: string[],
       selected_projects:{ name, action, reason }[]  // for the UI
     }
   ============================================================ */
"use strict";

const { str, strList } = require("./models");
const { LLMError, callGeminiOnce, parseLlmJson, isRetryable, DEFAULT_MODEL } = require("./llm");

const README_CHARS = 1800; // README chars sent per repo (bounds token cost)

/* ------------------------------------------------------------
   Strict response schema (Gemini's OpenAPI subset). We only let the
   model produce the projects region + skills suggestions — never the
   header, education, or anything outside the markers.
   ------------------------------------------------------------ */
const REGION_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    projects_latex: {
      type: "STRING",
      description:
        "The COMPLETE LaTeX to place between the project markers: all project " +
        "entries (kept + replaced), in the SAME number and the SAME style, " +
        "commands, indentation and spacing as the candidate's original region. " +
        "JD-matching keywords wrapped in \\textbf{}.",
    },
    skills_to_add: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Skills the JD asks for that the candidate demonstrably HAS (from repo " +
        "languages/topics/READMEs) but likely hasn't listed. Suggestions only.",
    },
    skills_to_remove: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Skills/technologies prominent in the candidate's projects that are NOT " +
        "relevant to THIS JD and could be trimmed. Suggestions only.",
    },
    selected_projects: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "Project / repo name." },
          action: { type: "STRING", description: 'One of: "kept", "replaced", "added".' },
          reason: { type: "STRING", description: "One short sentence: why, w.r.t. the JD." },
        },
        required: ["name", "action", "reason"],
      },
    },
  },
  required: ["projects_latex", "skills_to_add", "skills_to_remove", "selected_projects"],
};

const REGION_SYSTEM_INSTRUCTION = [
  "You are an expert technical recruiter and LaTeX resume editor. You surgically",
  "revise ONLY the Projects region of a candidate's existing LaTeX resume so it",
  "targets a specific Job Description (JD), while preserving their exact style.",
  "",
  "Hard rules:",
  "1. FORMAT FIDELITY: study the candidate's ORIGINAL projects region and reproduce",
  "   its EXACT LaTeX structure — the same commands/macros (e.g. \\item,",
  "   \\resumeProjectHeading, \\textbf, environments), the same indentation, blank",
  "   lines and spacing. Your output must drop into the document and read as if the",
  "   candidate wrote it. Do NOT introduce new macros the original didn't use.",
  "2. KEEP RELEVANT ORIGINALS: any original project that is relevant to the JD must",
  "   be kept VERBATIM (character-for-character). Do not reword kept projects.",
  "3. REPLACE ONLY THE WEAK ONES: replace an original project ONLY if it is not",
  "   relevant to the JD AND you found a GitHub repo that is clearly more relevant.",
  "   It is NOT required to replace every original — replace 0, 1, or 2 at most.",
  "4. KEEP THE COUNT THE SAME: output exactly as many project entries as the",
  "   original region contained. (If the original region is empty or only a",
  "   placeholder/comment, instead ADD the 1-2 best-matching repos.)",
  "5. DETAILED README ONLY: a GitHub repo may be used as a replacement/addition",
  "   ONLY if its README is detailed enough to ground specific, factual bullets.",
  "   Silently ignore repos with missing, empty, or thin READMEs.",
  "6. GROUNDING: base every new bullet ONLY on facts in that repo's README,",
  "   description, languages and topics. NEVER fabricate metrics, percentages,",
  "   users, dates, or technologies the repo does not show.",
  "7. KEYWORD HIGHLIGHT: within the project text, wrap the exact JD keywords that",
  "   the repo genuinely supports (e.g. React, Docker, PostgreSQL) in \\textbf{...}.",
  "   Only wrap real, supported keywords — never invent or over-highlight.",
  "8. BULLET QUALITY (applies ONLY to bullets you write for REPLACED/ADDED projects,",
  "   never to kept originals which stay verbatim): open each bullet with a strong",
  "   action verb (Built, Designed, Architected, Engineered, Optimized, Implemented,",
  "   Shipped); never with weak/passive phrasing (\"Worked on\", \"Helped with\",",
  "   \"Responsible for\", \"Supported\"). Avoid vague filler and keyword stuffing,",
  "   keep each bullet to one or two lines, and write \"and\" rather than \"&\".",
  "9. SKILLS SUGGESTIONS: skills_to_add = JD skills the candidate clearly has but",
  "   may not list; skills_to_remove = skills irrelevant to THIS JD they could trim.",
  "   These are suggestions for the UI — you do NOT edit any skills section.",
  "10. Output must satisfy the JSON schema exactly. projects_latex is the full",
  "   region text that goes BETWEEN the markers (do not include the marker lines).",
].join("\n");

/* ------------------------------------------------------------ Prompt */

/** Compact repo view for the model — includes the (truncated) README. */
function repoForPrompt(r) {
  const readme = str(r && r.readme);
  return {
    name: str(r && r.name),
    description: str(r && r.description),
    languages: Array.isArray(r && r.languages) ? r.languages : [],
    topics: Array.isArray(r && r.topics) ? r.topics : [],
    stargazers: (r && r.stargazers) || 0,
    url: str(r && r.url),
    readme: readme ? readme.slice(0, README_CHARS) : "",
    readme_length: readme.length, // lets the model gauge how detailed it is
  };
}

/**
 * Build the user-turn prompt: JD + the candidate's original projects region
 * + the candidate repos (with READMEs) as JSON.
 *
 * @param {object[]} repos           repos w/ readme
 * @param {string} jobDescription
 * @param {string} originalRegion    LaTeX between the project markers
 * @returns {string}
 */
function buildRegionPrompt(repos, jobDescription, originalRegion) {
  const compact = (Array.isArray(repos) ? repos : []).map(repoForPrompt);
  return [
    "JOB DESCRIPTION:",
    '"""',
    str(jobDescription),
    '"""',
    "",
    "CANDIDATE'S CURRENT PROJECTS REGION (the LaTeX BETWEEN the markers — mirror this",
    "exact style, commands and spacing; keep the same number of project entries):",
    '"""',
    str(originalRegion),
    '"""',
    "",
    "CANDIDATE GITHUB REPOSITORIES (possible replacements — use ONLY repos whose",
    "README is detailed enough to ground specific bullets):",
    JSON.stringify(compact, null, 2),
    "",
    "Rewrite the projects region per the rules: keep JD-relevant originals verbatim,",
    "replace only weak/irrelevant ones with more JD-relevant repos that have detailed",
    "READMEs, keep the entry count the same, match the LaTeX format exactly, and wrap",
    "JD-matching keywords in \\textbf{}. Then return skills_to_add and skills_to_remove.",
    "Return the JSON object.",
  ].join("\n");
}

/* ------------------------------------------------------------ Normalize */

/**
 * @typedef {Object} TailoredRegion
 * @property {string}   projects_latex
 * @property {string[]} skills_to_add
 * @property {string[]} skills_to_remove
 * @property {{ name: string, action: string, reason: string }[]} selected_projects
 */

/** Normalize the model output to our guaranteed shape. */
function normalizeRegion(parsed) {
  parsed = parsed || {};
  const ACTIONS = new Set(["kept", "replaced", "added"]);
  const selected_projects = (Array.isArray(parsed.selected_projects) ? parsed.selected_projects : [])
    .map((p) => {
      const action = str(p && p.action).toLowerCase();
      return {
        name: str(p && p.name),
        action: ACTIONS.has(action) ? action : "kept",
        reason: str(p && p.reason),
      };
    })
    .filter((p) => p.name);

  return {
    projects_latex: str(parsed.projects_latex),
    skills_to_add: strList(parsed.skills_to_add),
    skills_to_remove: strList(parsed.skills_to_remove),
    selected_projects,
  };
}

/* ------------------------------------------------------------ Entry point */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * PHASE 2 (BYOT) ENTRY POINT — rewrite the projects region for a JD.
 *
 * @param {object[]} repos            top-N pre-filtered repos, each WITH `readme`
 * @param {string}   jobDescription
 * @param {string}   originalRegion   LaTeX between the project markers
 * @param {{ apiKey?: string, model?: string, retries?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<TailoredRegion>}
 */
async function generateTailoredRegion(repos, jobDescription, originalRegion, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  const model = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const retries = Number.isFinite(options.retries) ? options.retries : 2;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!apiKey) throw new LLMError("config", "GEMINI_API_KEY is not set on the server.");
  if (typeof fetchImpl !== "function") throw new LLMError("config", "No fetch implementation available (need Node 18+).");
  if (!Array.isArray(repos) || repos.length === 0) throw new LLMError("input", "No repositories provided to the ATS layer.");
  if (!str(jobDescription)) throw new LLMError("input", "Job description is empty.");

  const userPrompt = buildRegionPrompt(repos, jobDescription, originalRegion);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await callGeminiOnce({
        apiKey,
        model,
        userPrompt,
        fetchImpl,
        systemInstruction: REGION_SYSTEM_INSTRUCTION,
        responseSchema: REGION_RESPONSE_SCHEMA,
        temperature: 0.3,
      });
      return normalizeRegion(parseLlmJson(text));
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryable(err)) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

module.exports = {
  REGION_RESPONSE_SCHEMA,
  REGION_SYSTEM_INSTRUCTION,
  buildRegionPrompt,
  normalizeRegion,
  generateTailoredRegion,
  README_CHARS,
};
