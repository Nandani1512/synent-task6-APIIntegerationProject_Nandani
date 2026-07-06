/* ============================================================
   JD -> LaTeX Resume Matcher — src/llm.js  (Phase 2)
   LLM intelligence layer (Google Gemini).

   Takes the top-7 pre-filtered repos + the full Job Description and
   asks Gemini, acting as an expert technical recruiter, to:
     - pick the 3-4 most relevant projects, and
     - write 3 X-Y-Z achievement bullets per project using ONLY facts
       present in the repo data (no invented metrics).
   The model is forced (via responseSchema / JSON mode) to return data
   conforming to the SelectedProject[] + matchedSkills shape, which the
   pipeline then merges into a full TailoredResumeData.

   Pure REST via fetch (Node 18+) — no SDK, so nothing to break when
   SDK versions churn. The API key is read from the environment and
   never leaves the server.
   ============================================================ */
"use strict";

const { str, strList, toSelectedProject } = require("./models");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_PROJECTS = 4; // hard cap: recruiter picks "3-4"
const MAX_BULLETS = 3; // X-Y-Z bullets per project

/** Typed error so the controller can branch on failure kind. */
class LLMError extends Error {
  /** @param {'config'|'input'|'http'|'blocked'|'empty'|'parse'} kind */
  constructor(kind, message, status) {
    super(message);
    this.name = "LLMError";
    this.kind = kind;
    this.status = status;
  }
}

/* ------------------------------------------------------------
   Strict response schema (Gemini's OpenAPI subset).
   We only let the model produce the parts it is responsible for —
   project selection + skills — never contact/education (which would
   invite hallucinated personal data).
   ------------------------------------------------------------ */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    matchedSkills: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Skills from the repos that match the JD, JD-relevance order.",
    },
    selectedProjects: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          description: { type: "STRING" },
          tailoredBullets: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "Exactly 3 X-Y-Z bullets grounded in repo facts.",
          },
          technologies: { type: "ARRAY", items: { type: "STRING" } },
          reason: {
            type: "STRING",
            description: "One short sentence: why this project fits the JD.",
          },
        },
        required: ["name", "description", "tailoredBullets", "technologies", "reason"],
      },
    },
  },
  required: ["matchedSkills", "selectedProjects"],
};

const SYSTEM_INSTRUCTION = [
  "You are an expert technical recruiter and professional resume writer.",
  "You tailor a candidate's GitHub projects to a specific Job Description (JD).",
  "",
  "Hard rules:",
  "1. Choose the 3 to 4 projects MOST relevant to the JD. Never more than 4.",
  "2. For each chosen project write exactly 3 achievement bullets using the",
  "   X-Y-Z formula: \"Accomplished X, as measured by Y, by doing Z\".",
  "3. Ground every bullet ONLY in facts present in the provided repository",
  "   data (name, description, languages, topics, stars, forks, homepage).",
  "   NEVER invent metrics, percentages, user counts, dollar amounts, dates,",
  "   or technologies that are not in the data. If no numeric measure exists,",
  "   express Y qualitatively from real facts (e.g. a feature, a language",
  "   count, stargazers) rather than fabricating a number.",
  "4. `technologies` must be drawn from the repo's languages/topics only.",
  "5. `matchedSkills` lists the candidate's real skills that the JD asks for,",
  "   ordered by how strongly the JD emphasizes them.",
  "6. For each chosen project add `reason`: one short sentence explaining",
  "   why it matches THIS job description (skills/tech overlap).",
  "7. POWER VERBS: start every bullet with a strong action verb (Built, Designed,",
  "   Architected, Engineered, Led, Optimized, Implemented, Shipped). NEVER open",
  "   with weak/passive phrasing such as \"Worked on\", \"Helped with\",",
  "   \"Responsible for\", \"Supported\", \"Assisted\" — these read as no ownership.",
  "8. RED FLAGS to avoid: passive voice, vague filler (\"various features\"),",
  "   keyword stuffing without evidence, and bullets with no concrete result.",
  "9. ATS-FRIENDLY: write \"and\" not \"&\"; keep each bullet to one or two lines;",
  "   mirror the JD's exact wording for a skill when the repo genuinely supports it.",
  "10. Be concise and recruiter-friendly. Output must satisfy the JSON schema.",
].join("\n");

/* ------------------------------------------------------------ Prompt */

/** Compact repo view — only the fields the model should reason over. */
function repoForPrompt(r) {
  return {
    name: r.name,
    description: r.description,
    languages: r.languages,
    topics: r.topics,
    stargazers: r.stargazers,
    forks: r.forks,
    homepage: r.homepage || "",
  };
}

/**
 * Build the user-turn prompt: the JD plus the candidate repos as JSON.
 *
 * @param {import('./models').GithubRepoMetadata[]} repos
 * @param {string} jobDescription
 * @returns {string}
 */
function buildRecruiterPrompt(repos, jobDescription) {
  const compact = repos.map(repoForPrompt);
  return [
    "JOB DESCRIPTION:",
    '"""',
    str(jobDescription),
    '"""',
    "",
    "CANDIDATE GITHUB REPOSITORIES (facts you may use — nothing else):",
    JSON.stringify(compact, null, 2),
    "",
    "Select the 3-4 best-matching projects and return the JSON object.",
  ].join("\n");
}

/* ------------------------------------------------------------ JSON parsing */

/**
 * Parse the model's text into an object. JSON mode normally returns clean
 * JSON, but we defensively strip ``` fences / surrounding prose and grab the
 * outermost {...} so a stray wrapper never crashes the pipeline.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseLlmJson(text) {
  const raw = str(text);
  if (!raw) throw new LLMError("parse", "LLM returned empty text.");

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new LLMError("parse", "Could not parse JSON from the LLM response.");
  }
}

/** Normalize + clamp the model output to our guarantees (<=4 projects, <=3 bullets). */
function normalizeSelection(parsed) {
  const projects = Array.isArray(parsed.selectedProjects)
    ? parsed.selectedProjects
    : parsed.selected_projects;

  const selectedProjects = (Array.isArray(projects) ? projects : [])
    .slice(0, MAX_PROJECTS)
    .map(toSelectedProject)
    .map((p) => ({ ...p, tailoredBullets: p.tailoredBullets.slice(0, MAX_BULLETS) }));

  return {
    matchedSkills: strList(parsed.matchedSkills ?? parsed.matched_skills),
    selectedProjects,
  };
}

/* ------------------------------------------------------------ Gemini call */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Single Gemini generateContent call. Returns the raw text of the first
 * candidate. Throws LLMError on transport / safety / empty problems.
 */
async function callGeminiOnce({
  apiKey,
  model,
  userPrompt,
  fetchImpl,
  // Optional overrides so other layers (e.g. the ATS BYOT flow in ats.js) can
  // reuse this exact transport with their own prompt + schema. Default to the
  // generate-tailored constants, so existing callers are unaffected.
  systemInstruction = SYSTEM_INSTRUCTION,
  responseSchema = RESPONSE_SCHEMA,
  temperature = 0.35, // low: we want faithful, not creative
}) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature,
    },
  };

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LLMError("http", `Network error calling Gemini: ${err.message}`, 0);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LLMError("http", `Gemini HTTP ${res.status}: ${detail.slice(0, 400)}`, res.status);
  }

  const data = await res.json().catch(() => null);
  const candidate = data && data.candidates && data.candidates[0];
  if (!candidate) {
    const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
    throw new LLMError("blocked", blockReason ? `Gemini blocked the prompt: ${blockReason}` : "Gemini returned no candidates.");
  }

  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.map((p) => p.text || "").join("");
  if (!text.trim()) throw new LLMError("empty", "Gemini returned an empty completion.");
  return text;
}

/** Retry transient failures (network / 5xx / 429) with linear backoff. */
function isRetryable(err) {
  return err instanceof LLMError && err.kind === "http" && (err.status === 0 || err.status === 429 || err.status >= 500);
}

/**
 * PHASE 2 ENTRY POINT.
 * Pick + tailor projects for a JD.
 *
 * @param {import('./models').GithubRepoMetadata[]} repos  top-N pre-filtered repos
 * @param {string} jobDescription
 * @param {{ apiKey?: string, model?: string, retries?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ matchedSkills: string[], selectedProjects: import('./models').SelectedProject[] }>}
 */
async function generateTailoredSelection(repos, jobDescription, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  const model = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const retries = Number.isFinite(options.retries) ? options.retries : 2;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!apiKey) throw new LLMError("config", "GEMINI_API_KEY is not set on the server.");
  if (typeof fetchImpl !== "function") throw new LLMError("config", "No fetch implementation available (need Node 18+).");
  if (!Array.isArray(repos) || repos.length === 0) throw new LLMError("input", "No repositories provided to the LLM layer.");
  if (!str(jobDescription)) throw new LLMError("input", "Job description is empty.");

  const userPrompt = buildRecruiterPrompt(repos, jobDescription);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await callGeminiOnce({ apiKey, model, userPrompt, fetchImpl });
      const result = normalizeSelection(parseLlmJson(text));
      if (!result.selectedProjects.length) throw new LLMError("empty", "LLM selected no projects.");
      return result;
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
  LLMError,
  RESPONSE_SCHEMA,
  SYSTEM_INSTRUCTION,
  buildRecruiterPrompt,
  parseLlmJson,
  normalizeSelection,
  generateTailoredSelection,
  // Low-level transport reused by the ATS BYOT layer (src/ats.js):
  callGeminiOnce,
  isRetryable,
  DEFAULT_MODEL,
};
