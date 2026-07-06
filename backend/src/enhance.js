/* ============================================================
   JD -> LaTeX Resume Matcher — src/enhance.js
   JD-driven, whole-resume enhancement advisor (Gemini).

   Complements the BYOT tailor flow (src/ats.js), which surgically
   rewrites only the projects region. This layer takes the candidate's
   FULL resume text + the target Job Description and, acting as an expert
   technical recruiter, returns actionable feedback for the whole resume:

     - keyword coverage vs the JD (match % + matched / missing keywords),
     - JD-relevant strengths already present,
     - gaps (what the JD wants that the resume doesn't show) + how to fix,
     - concrete bullet rewrites (original -> stronger, JD-mirrored),
     - ATS / formatting issues (passive verbs, "&", filler, etc.),
     - skills to add / remove for THIS JD.

   It is advisory only — it never edits or returns a rewritten resume,
   so nothing is fabricated INTO the document. Every suggestion is
   grounded in the resume text + JD the caller supplied.

   Reuses the exact Gemini transport (callGeminiOnce) from llm.js with
   its own system prompt + response schema, exactly like ats.js.
   ============================================================ */
"use strict";

const { str, strList, num } = require("./models");
const { LLMError, callGeminiOnce, parseLlmJson, isRetryable, DEFAULT_MODEL } = require("./llm");

const MAX_STRENGTHS = 6;
const MAX_GAPS = 6;
const MAX_REWRITES = 8;
const MAX_ATS = 6;

/* ------------------------------------------------------------
   Strict response schema (Gemini's OpenAPI subset). The model only
   produces ADVICE about the resume — it never returns a rewritten
   resume document, so it can't smuggle fabricated content back in.
   ------------------------------------------------------------ */
const ENHANCE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: {
      type: "STRING",
      description: "2-3 sentence honest, specific overview of how well the resume fits THIS JD.",
    },
    keywordMatch: {
      type: "OBJECT",
      properties: {
        matchPercent: {
          type: "INTEGER",
          description: "0-100: share of the JD's important keywords the resume demonstrably covers.",
        },
        matchedKeywords: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "JD keywords the resume clearly supports with evidence.",
        },
        missingKeywords: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "Important JD keywords absent from the resume, JD-priority order.",
        },
      },
      required: ["matchPercent", "matchedKeywords", "missingKeywords"],
    },
    strengths: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Top JD-relevant strengths already in the resume, each citing concrete evidence.",
    },
    gaps: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          gap: { type: "STRING", description: "A specific thing the JD wants that the resume doesn't show." },
          severity: { type: "STRING", description: 'One of: "high", "medium", "low".' },
          fix: { type: "STRING", description: "Exact, concrete action to close the gap — never generic advice." },
        },
        required: ["gap", "severity", "fix"],
      },
    },
    bulletRewrites: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          original: { type: "STRING", description: "The exact weak bullet copied verbatim from the resume." },
          suggested: { type: "STRING", description: "A stronger rewrite: action verb + what + measurable result, JD-mirrored." },
          why: { type: "STRING", description: "One short sentence: why the rewrite is better." },
        },
        required: ["original", "suggested", "why"],
      },
    },
    atsIssues: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          issue: { type: "STRING", description: "An ATS / formatting problem (passive verb, '&', filler, no metric, etc.)." },
          fix: { type: "STRING", description: "How to fix it." },
        },
        required: ["issue", "fix"],
      },
    },
    skillsToAdd: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "JD skills the resume clearly demonstrates but may not list explicitly.",
    },
    skillsToRemove: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Skills prominent on the resume that are irrelevant to THIS JD and could be trimmed.",
    },
  },
  required: ["summary", "keywordMatch", "strengths", "gaps", "bulletRewrites", "atsIssues"],
};

const ENHANCE_SYSTEM_INSTRUCTION = [
  "You are an expert technical recruiter and resume coach with 10 years of FAANG",
  "hiring experience. You review a candidate's resume against a specific Job",
  "Description (JD) and return brutally honest, SPECIFIC, actionable enhancements.",
  "You give advice only — you never output a rewritten resume document.",
  "",
  "Hard rules:",
  "1. GROUNDING: base every observation ONLY on the resume text and the JD the user",
  "   provides. NEVER invent experience, metrics, employers, or technologies the",
  "   resume does not contain. If evidence is absent, treat it as a gap, not a fact.",
  "2. NO GENERIC ADVICE: \"improve your resume\" is banned. Every fix must be concrete",
  "   — exact text to change, exact keyword to add, exact section to touch.",
  "3. KEYWORD MATCH: extract the JD's important skills/keywords, then judge which the",
  "   resume genuinely supports (matched) vs which are absent (missing). matchPercent",
  "   is the share of important JD keywords that are covered.",
  "4. BULLET REWRITES: for weak bullets, copy the ORIGINAL verbatim from the resume,",
  "   then rewrite as [Action Verb] + [What you did] + [Measurable Result]. Open with a",
  "   strong verb (Built, Designed, Architected, Engineered, Led, Optimized, Shipped);",
  "   never with weak/passive phrasing (\"Worked on\", \"Helped with\", \"Responsible for\",",
  "   \"Supported\"). Mirror the JD's exact wording for a skill the resume truly supports.",
  "   Do NOT fabricate numbers — only propose a metric if the resume already implies one.",
  "5. ATS ISSUES: flag passive voice, \"&\" instead of \"and\", vague filler",
  "   (\"various features\"), keyword stuffing without evidence, bullets over two lines,",
  "   and non-standard section headers.",
  "6. SKILLS: skillsToAdd = JD skills the resume clearly demonstrates but may not list;",
  "   skillsToRemove = resume skills irrelevant to THIS JD. Suggestions only.",
  "7. Be concise, evidence-based, and honest. Output must satisfy the JSON schema.",
].join("\n");

/* ------------------------------------------------------------ Prompt */

/**
 * Build the user-turn prompt: the JD plus the candidate's full resume text.
 *
 * @param {string} resumeText
 * @param {string} jobDescription
 * @returns {string}
 */
function buildEnhancePrompt(resumeText, jobDescription) {
  return [
    "JOB DESCRIPTION:",
    '"""',
    str(jobDescription),
    '"""',
    "",
    "CANDIDATE RESUME (the only facts you may use about the candidate — the text may be",
    "plain text or LaTeX source; read through any markup to the underlying content):",
    '"""',
    str(resumeText),
    '"""',
    "",
    "Review the resume against the JD per the rules: compute the keyword match, list",
    "JD-relevant strengths with evidence, list gaps with concrete fixes, rewrite weak",
    "bullets (original verbatim -> stronger, JD-mirrored, no fabricated metrics), flag",
    "ATS issues, and suggest skills to add / remove. Return the JSON object.",
  ].join("\n");
}

/* ------------------------------------------------------------ Normalize */

const SEVERITIES = new Set(["high", "medium", "low"]);

/** Clamp a number into [lo, hi]. */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, num(n)));
}

/**
 * @typedef {Object} ResumeEnhancement
 * @property {string} summary
 * @property {{ matchPercent: number, matchedKeywords: string[], missingKeywords: string[] }} keywordMatch
 * @property {string[]} strengths
 * @property {{ gap: string, severity: string, fix: string }[]} gaps
 * @property {{ original: string, suggested: string, why: string }[]} bulletRewrites
 * @property {{ issue: string, fix: string }[]} atsIssues
 * @property {string[]} skillsToAdd
 * @property {string[]} skillsToRemove
 */

/** Normalize + clamp the model output to our guaranteed shape. */
function normalizeEnhancement(parsed) {
  parsed = parsed || {};
  const km = parsed.keywordMatch || parsed.keyword_match || {};

  const gaps = (Array.isArray(parsed.gaps) ? parsed.gaps : [])
    .map((g) => {
      const severity = str(g && g.severity).toLowerCase();
      return {
        gap: str(g && g.gap),
        severity: SEVERITIES.has(severity) ? severity : "medium",
        fix: str(g && g.fix),
      };
    })
    .filter((g) => g.gap)
    .slice(0, MAX_GAPS);

  const bulletRewrites = (Array.isArray(parsed.bulletRewrites) ? parsed.bulletRewrites : [])
    .map((r) => ({
      original: str(r && r.original),
      suggested: str(r && r.suggested),
      why: str(r && r.why),
    }))
    .filter((r) => r.original && r.suggested)
    .slice(0, MAX_REWRITES);

  const atsIssues = (Array.isArray(parsed.atsIssues) ? parsed.atsIssues : [])
    .map((a) => ({ issue: str(a && a.issue), fix: str(a && a.fix) }))
    .filter((a) => a.issue)
    .slice(0, MAX_ATS);

  return {
    summary: str(parsed.summary),
    keywordMatch: {
      matchPercent: Math.round(clamp(km.matchPercent ?? km.match_percent, 0, 100)),
      matchedKeywords: strList(km.matchedKeywords ?? km.matched_keywords),
      missingKeywords: strList(km.missingKeywords ?? km.missing_keywords),
    },
    strengths: strList(parsed.strengths).slice(0, MAX_STRENGTHS),
    gaps,
    bulletRewrites,
    atsIssues,
    skillsToAdd: strList(parsed.skillsToAdd ?? parsed.skills_to_add),
    skillsToRemove: strList(parsed.skillsToRemove ?? parsed.skills_to_remove),
  };
}

/* ------------------------------------------------------------ Entry point */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ENTRY POINT — review + enhance a resume against a JD.
 *
 * @param {string} resumeText       full resume (plain text or LaTeX source)
 * @param {string} jobDescription
 * @param {{ apiKey?: string, model?: string, retries?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<ResumeEnhancement>}
 */
async function enhanceResume(resumeText, jobDescription, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  const model = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const retries = Number.isFinite(options.retries) ? options.retries : 2;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!apiKey) throw new LLMError("config", "GEMINI_API_KEY is not set on the server.");
  if (typeof fetchImpl !== "function") throw new LLMError("config", "No fetch implementation available (need Node 18+).");
  if (!str(resumeText)) throw new LLMError("input", "Resume text is empty.");
  if (!str(jobDescription)) throw new LLMError("input", "Job description is empty.");

  const userPrompt = buildEnhancePrompt(resumeText, jobDescription);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await callGeminiOnce({
        apiKey,
        model,
        userPrompt,
        fetchImpl,
        systemInstruction: ENHANCE_SYSTEM_INSTRUCTION,
        responseSchema: ENHANCE_RESPONSE_SCHEMA,
        temperature: 0.3,
      });
      return normalizeEnhancement(parseLlmJson(text));
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
  ENHANCE_RESPONSE_SCHEMA,
  ENHANCE_SYSTEM_INSTRUCTION,
  buildEnhancePrompt,
  normalizeEnhancement,
  enhanceResume,
};
