/* Offline smoke for Phases 3-4 (BYOT region rewrite + pipeline).
   No network, no API key. Run: node test/byot.smoke.js  (from backend/) */
"use strict";

const assert = require("assert");
const byot = require("../src/byot");
const pipeline = require("../src/byotPipeline");

let passed = 0;
const ok = (label) => { console.log("  ok -", label); passed++; };

/* ---- Phase 3: marker helpers ---- */
const tpl = [
  "\\section{Skills}",
  "  Python, C++  % keep me exactly",
  "\\section{Projects}",
  "  % --- AI_PROJECTS_START --- %",
  "  \\item \\textbf{old-project} original bullet",
  "  % --- AI_PROJECTS_END --- %",
  "\\end{document}",
].join("\n");

assert.ok(byot.hasProjectMarkers(tpl));
assert.ok(!byot.hasProjectMarkers("no markers here"));
ok("hasProjectMarkers detects both markers");

/* ---- Phase 3: extract the original region ---- */
const region = byot.getProjectsRegion(tpl);
assert.ok(region.includes("\\item \\textbf{old-project} original bullet"), "region extracted");
assert.ok(!region.includes("AI_PROJECTS_START"), "markers excluded from region");
assert.strictEqual(byot.getProjectsRegion("no markers"), "", "empty when markers absent");
ok("getProjectsRegion returns the content between the markers");

/* ---- Phase 3: raw region replacement keeps everything else identical ---- */
const newRegion = "  \\item \\textbf{react-app} Built a \\textbf{React} dashboard";
const out = byot.replaceProjectsRegion(tpl, newRegion);

// Outside the markers: byte-for-byte unchanged.
const before = out.latex.slice(0, out.latex.indexOf(byot.MARKERS.projects.start) + byot.MARKERS.projects.start.length);
const origBefore = tpl.slice(0, tpl.indexOf(byot.MARKERS.projects.start) + byot.MARKERS.projects.start.length);
assert.strictEqual(before, origBefore, "text before START marker unchanged");
const after = out.latex.slice(out.latex.indexOf(byot.MARKERS.projects.end));
const origAfter = tpl.slice(tpl.indexOf(byot.MARKERS.projects.end));
assert.strictEqual(after, origAfter, "text after END marker unchanged");

assert.ok(out.latex.includes("Python, C++  % keep me exactly"), "skills line untouched");
assert.ok(out.latex.includes("\\textbf{react-app}"), "new region injected verbatim");
assert.ok(!out.latex.includes("old-project"), "old region replaced");
assert.ok(out.latex.includes("\\textbf{React}"), "LaTeX kept raw (keyword highlight preserved)");
assert.strictEqual(out.injectedProjects, true);
assert.strictEqual(out.warnings.length, 0);
ok("replaceProjectsRegion swaps only the region, verbatim, everything else identical");

/* empty region -> keep original + warn */
const kept = byot.replaceProjectsRegion(tpl, "   ");
assert.strictEqual(kept.latex, tpl, "empty region keeps the original template unchanged");
assert.ok(kept.warnings.length >= 1);
assert.strictEqual(kept.injectedProjects, false);
ok("replaceProjectsRegion keeps originals when the model returns nothing");

/* missing markers -> warn, no change */
const noMarkers = byot.replaceProjectsRegion("just text", newRegion);
assert.strictEqual(noMarkers.latex, "just text");
assert.ok(noMarkers.warnings.length >= 1);
assert.ok(!noMarkers.injectedProjects);
ok("replaceProjectsRegion warns on missing markers");

/* ---- Phase 4: full BYOT pipeline with fake fetch ---- */
const jsonRes = (obj) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => obj, text: async () => JSON.stringify(obj),
});
const textRes = (t) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({}), text: async () => t,
});

const pipelineFetch = async (url) => {
  if (url.includes("api.github.com") && url.includes("/repos?")) {
    return jsonRes([
      { id: 1, name: "react-dashboard", description: "Dashboard in React + TypeScript", stargazers_count: 42, language: "TypeScript", topics: ["react", "docker"], updated_at: "2026-04-01T00:00:00Z", owner: { login: "ada" }, fork: false, html_url: "https://github.com/ada/react-dashboard" },
      { id: 2, name: "flask-api", description: "REST API in Python", stargazers_count: 10, language: "Python", topics: ["api"], updated_at: "2025-01-01T00:00:00Z", owner: { login: "ada" }, fork: false, html_url: "https://github.com/ada/flask-api" },
    ]);
  }
  if (url.includes("/languages")) return jsonRes({ TypeScript: 1000, Dockerfile: 200 });
  if (url.includes("/readme")) return textRes("# React Dashboard\n\nA detailed README describing a React + TypeScript analytics dashboard, Docker deployment, and charts.");
  if (url.includes("generativelanguage.googleapis.com")) {
    return jsonRes({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      projects_latex: "  \\item \\textbf{react-dashboard} Built a \\textbf{React} + \\textbf{TypeScript} dashboard, \\textbf{Docker}-deployed.",
      skills_to_add: ["Docker"],
      skills_to_remove: ["jQuery"],
      selected_projects: [
        { name: "react-dashboard", action: "added", reason: "Direct match on React/TypeScript from the JD." },
      ],
    }) }] } }] });
  }
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
};

(async () => {
  const tmpl = [
    "\\section{Skills}",
    "  React, TypeScript",
    "\\section{Projects}",
    "  % --- AI_PROJECTS_START --- %",
    "  \\item \\textbf{placeholder} old text",
    "  % --- AI_PROJECTS_END --- %",
    "\\end{document}",
  ].join("\n");

  const out = await pipeline.tailorTemplate(
    { githubUsername: "ada", jobDescription: "Frontend Developer: React, TypeScript, Docker.", latexTemplate: tmpl },
    { apiKey: "test", fetchImpl: pipelineFetch }
  );

  assert.ok(out.latex.includes("\\textbf{react-dashboard}"), "pipeline injected the rewritten region");
  assert.ok(out.latex.includes("\\textbf{React}"), "JD keyword highlighted (raw LaTeX preserved)");
  assert.ok(out.latex.includes("React, TypeScript") && out.latex.includes("\\section{Skills}"), "skills section untouched");
  assert.ok(!out.latex.includes("placeholder"), "old region replaced");
  assert.deepStrictEqual(out.skillsToAdd, ["Docker"]);
  assert.deepStrictEqual(out.skillsToRemove, ["jQuery"]);
  assert.strictEqual(out.selectedProjects[0].action, "added");
  assert.ok(out.consideredRepos.some((r) => r.hasReadme), "README presence surfaced");
  assert.strictEqual(out.warnings.length, 0);
  ok("full BYOT pipeline (fetch -> prefilter -> README -> LLM region -> swap) end-to-end");

  /* missing template markers -> 400 */
  await assert.rejects(
    () => pipeline.tailorTemplate({ githubUsername: "ada", jobDescription: "JD", latexTemplate: "no markers" }, { apiKey: "test", fetchImpl: pipelineFetch }),
    (e) => e.status === 400 && e.kind === "input"
  );
  ok("missing markers throws input error (400)");

  console.log(`\nAll ${passed} checks passed.`);
})().catch((e) => {
  console.error("BYOT SMOKE TEST FAILED:", e);
  process.exit(1);
});
