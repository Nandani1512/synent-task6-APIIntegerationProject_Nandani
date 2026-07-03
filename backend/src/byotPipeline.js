/* ============================================================
   JD -> LaTeX Resume Matcher — src/byotPipeline.js  (Phase 4)
   Orchestrator for the Bring-Your-Own-Template flow.

     fetch GitHub repos  ->  prefilter (top N, Phase 1)
        ->  fetch READMEs for the top candidates
        ->  extract the user's ORIGINAL projects region
        ->  LLM rewrite of that region (keep relevant, replace weak,
            same count, same format, README-grounded, keyword-highlighted)
        ->  surgical swap of ONLY that region back into the template

   Pure logic, fully STATELESS — nothing is written to disk. The HTTP
   controller in server.js is a thin wrapper around tailorTemplate.
   ============================================================ */
"use strict";

const { getReposForUser, attachReadmes } = require("./github");
const prefilter = require("./prefilter");
const { generateTailoredRegion } = require("./ats");
const byot = require("./byot");

const TOP_N = 7;          // repos ranked and considered
const README_TOP_N = 6;   // of those, how many get their README fetched

/** A small error carrying an HTTP status for the controller. */
function httpError(status, message, kind) {
  const e = new Error(message);
  e.status = status;
  e.kind = kind || "input";
  return e;
}

/**
 * PHASE 4 ENTRY POINT — tailor a user's LaTeX template to a JD by
 * surgically rewriting ONLY the projects region.
 *
 * @param {{ githubUsername: string, jobDescription: string, latexTemplate: string }} input
 * @param {{ apiKey?: string, model?: string, githubToken?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{
 *   latex: string,
 *   warnings: string[],
 *   skillsToAdd: string[],
 *   skillsToRemove: string[],
 *   selectedProjects: { name: string, action: string, reason: string }[],
 *   consideredRepos: { name: string, stargazers: number, languages: string[], url: string, matchedKeywords: string[], score: number, hasReadme: boolean }[],
 * }>}
 */
async function tailorTemplate(input, opts = {}) {
  const githubUsername = String((input && input.githubUsername) || "").trim();
  const jobDescription = (input && input.jobDescription) || "";
  const latexTemplate = (input && input.latexTemplate) || "";

  // ---- validation ----
  if (!githubUsername) throw httpError(400, "github_username is required.");
  if (!String(jobDescription).trim()) throw httpError(400, "job_description is required.");
  if (!String(latexTemplate).trim()) throw httpError(400, "latex_template is required.");
  if (!byot.hasProjectMarkers(latexTemplate)) {
    throw httpError(
      400,
      `latex_template is missing the required project markers: "${byot.MARKERS.projects.start}" … "${byot.MARKERS.projects.end}".`,
      "input"
    );
  }

  // 1. fetch repos
  const repos = await getReposForUser(githubUsername, { token: opts.githubToken, fetchImpl: opts.fetchImpl });
  if (!repos.length) throw httpError(404, `No public repositories found for "${githubUsername}".`, "notfound");

  // 2. prefilter (Phase 1) — rankRepos keeps score + matched keywords for transparency
  const ranked = prefilter.rankRepos(repos, jobDescription).slice(0, TOP_N);
  const top = ranked.map((r) => r.repo);

  // 3. fetch READMEs for the top candidates so the LLM can judge detail + ground bullets
  const withReadmes = await attachReadmes(githubUsername, top.slice(0, README_TOP_N), {
    token: opts.githubToken,
    fetchImpl: opts.fetchImpl,
  });
  // repos beyond README_TOP_N are still passed (with empty readme) for context
  const candidates = withReadmes.concat(top.slice(README_TOP_N).map((r) => ({ ...r, readme: "" })));
  const readmeByName = new Map(candidates.map((r) => [r.name, r.readme]));

  // 4. extract the user's ORIGINAL projects region (to preserve style + relevant entries)
  const originalRegion = byot.getProjectsRegion(latexTemplate);

  // 5. LLM rewrite of the region (Phase 2)
  const region = await generateTailoredRegion(candidates, jobDescription, originalRegion, {
    apiKey: opts.apiKey,
    model: opts.model,
    fetchImpl: opts.fetchImpl,
  });

  // 6. surgical swap of ONLY the projects region (raw — the model matched the format)
  const injected = byot.replaceProjectsRegion(latexTemplate, region.projects_latex);

  return {
    latex: injected.latex,
    warnings: injected.warnings,
    skillsToAdd: region.skills_to_add,
    skillsToRemove: region.skills_to_remove,
    selectedProjects: region.selected_projects,
    consideredRepos: ranked.map((r) => ({
      name: r.repo.name,
      stargazers: r.repo.stargazers,
      languages: r.repo.languages,
      url: r.repo.url,
      matchedKeywords: r.matchedKeywords,
      score: r.score,
      hasReadme: !!(readmeByName.get(r.repo.name) || "").trim(),
    })),
  };
}

module.exports = { tailorTemplate, TOP_N, README_TOP_N };
