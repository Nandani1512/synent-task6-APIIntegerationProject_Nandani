/* ============================================================
   JD -> LaTeX Resume Matcher — src/byot.js  (Phase 3, BYOT flow)
   Surgical, format-preserving projects-region swap.

   The frontend sends a RAW LaTeX string (the user's own resume
   template). The LLM (Phase 2) returns a rewritten PROJECTS region
   already formatted to match the user's style. This module:
     1. reads the ORIGINAL content between the project markers (so the
        LLM can preserve style + keep JD-relevant projects), and
     2. SURGICALLY swaps only that content back in, VERBATIM, leaving
        the markers and the entire rest of the template byte-for-byte
        untouched so the same template can be re-tailored repeatedly.

   Marker contract (the user must place these in their template):
     % --- AI_PROJECTS_START --- %   ...projects go here...   % --- AI_PROJECTS_END --- %

   PROJECTS-ONLY: the projects region is the ONLY thing we ever modify;
   the header, education, and skills sections are never touched. Skill
   changes are returned to the UI as suggestions, never written to file.
   ============================================================ */
"use strict";

/** Exact marker tags. These are matched literally (never regex-built). */
const MARKERS = {
  projects: {
    start: "% --- AI_PROJECTS_START --- %",
    end: "% --- AI_PROJECTS_END --- %",
  },
};

/**
 * Replace the text BETWEEN two literal marker tags with `replacement`,
 * keeping both markers in place (so the template stays re-tailorable).
 * Uses indexOf/slice — never String.replace — so `$`, `\` etc. in the
 * replacement are inserted verbatim (no special-pattern interpretation).
 *
 * @returns {{ ok: boolean, text: string }} ok=false if markers are absent/misordered
 */
function replaceBetween(source, startTag, endTag, replacement) {
  const s = source.indexOf(startTag);
  if (s === -1) return { ok: false, text: source };
  const e = source.indexOf(endTag, s + startTag.length);
  if (e === -1) return { ok: false, text: source };

  const before = source.slice(0, s + startTag.length);
  const after = source.slice(e);
  return { ok: true, text: `${before}\n${replacement}\n${after}` };
}

/** True if the template contains BOTH project markers (the required pair). */
function hasProjectMarkers(template) {
  const s = String(template || "");
  return s.includes(MARKERS.projects.start) && s.includes(MARKERS.projects.end);
}

/**
 * Return the raw content BETWEEN the project markers (exclusive of the
 * markers themselves). This is the user's ORIGINAL projects region, which
 * we hand to the LLM so it can preserve the exact style/spacing while
 * swapping in JD-relevant repos. Returns "" if the markers are absent.
 *
 * @param {string} template
 * @returns {string}
 */
function getProjectsRegion(template) {
  const source = String(template || "");
  const s = source.indexOf(MARKERS.projects.start);
  if (s === -1) return "";
  const e = source.indexOf(MARKERS.projects.end, s + MARKERS.projects.start.length);
  if (e === -1) return "";
  return source.slice(s + MARKERS.projects.start.length, e);
}

/**
 * Replace the projects region with LLM-authored LaTeX VERBATIM (no
 * sanitization): the model returns the region already formatted to match
 * the user's template, so escaping would corrupt its `\item`, `\textbf`,
 * etc. Everything outside the markers is left byte-for-byte identical.
 * If `projectsLatex` is empty we keep the original region untouched.
 *
 * @param {string} template
 * @param {string} projectsLatex  LaTeX for BETWEEN the markers
 * @returns {{ latex: string, warnings: string[], injectedProjects: boolean }}
 */
function replaceProjectsRegion(template, projectsLatex) {
  const latex = String(template || "");
  const body = String(projectsLatex || "").trim();
  const warnings = [];

  if (!body) {
    warnings.push("The model returned no projects region — the original projects were kept unchanged.");
    return { latex, warnings, injectedProjects: false };
  }

  const pr = replaceBetween(latex, MARKERS.projects.start, MARKERS.projects.end, body);
  if (!pr.ok) {
    warnings.push(`Project markers ("${MARKERS.projects.start}" … "${MARKERS.projects.end}") not found — projects were not injected.`);
    return { latex, warnings, injectedProjects: false };
  }
  return { latex: pr.text, warnings, injectedProjects: true };
}

module.exports = {
  MARKERS,
  replaceBetween,
  hasProjectMarkers,
  getProjectsRegion,
  replaceProjectsRegion,
};
