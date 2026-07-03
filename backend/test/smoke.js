/* Offline smoke test for Phases 1-2. No network, no API key.
   Run: node test/smoke.js   (from backend/)  */
"use strict";

const assert = require("assert");
const { toRepoMetadata } = require("../src/models");
const prefilter = require("../src/prefilter");
const llm = require("../src/llm");
const latex = require("../src/latex");
const pipeline = require("../src/pipeline");

let passed = 0;
const ok = (label) => { console.log("  ok -", label); passed++; };

/* ---- fixtures: raw GitHub-style repos ---- */
const rawRepos = [
  { id: 1, name: "react-dashboard", description: "Analytics dashboard in React + TypeScript", stargazers_count: 42, language: "TypeScript", topics: ["react", "charts"], updated_at: "2026-04-01T00:00:00Z", html_url: "https://github.com/x/react-dashboard" },
  { id: 2, name: "flask-api", description: "REST API in Python with PostgreSQL", stargazers_count: 10, language: "Python", topics: ["api", "backend"], updated_at: "2025-01-01T00:00:00Z" },
  { id: 3, name: "snake-game", description: "Terminal snake game", stargazers_count: 3, language: "C", topics: [], updated_at: "2021-01-01T00:00:00Z" },
];
const repos = rawRepos.map((r) => toRepoMetadata(r));
const JD = "Seeking a Frontend Developer strong in React and TypeScript to build dashboards. REST API experience a plus.";
const NOW = Date.parse("2026-06-21T00:00:00Z");

/* ---- Phase 1: profiling + prefilter ---- */
const profile = prefilter.profileJobDescription(JD);
assert.strictEqual(profile.primaryRole, "Frontend Developer");
assert.ok(profile.technicalSkillsDemanded.includes("react"));
ok("JD profile detects role + tech");

const top = prefilter.prefilterRepos(repos, JD, 7, { now: NOW });
assert.strictEqual(top[0].name, "react-dashboard");
ok("prefilter ranks the React/TS repo first");

/* ---- Phase 2: LLM layer with an injected fake fetch ---- */
function fakeFetch(cannedObject) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(cannedObject) }] } }],
    }),
    text: async () => "",
  });
}

const canned = {
  matchedSkills: ["React", "TypeScript", "REST APIs"],
  selectedProjects: [
    {
      name: "react-dashboard",
      description: "Analytics dashboard in React + TypeScript",
      tailoredBullets: ["b1", "b2", "b3", "b4 (extra, should be trimmed)"],
      technologies: ["React", "TypeScript"],
    },
    { name: "flask-api", description: "REST API", tailoredBullets: ["x"], technologies: ["Python"] },
    { name: "p3", description: "", tailoredBullets: [], technologies: [] },
    { name: "p4", description: "", tailoredBullets: [], technologies: [] },
    { name: "p5 (extra, should be trimmed)", description: "", tailoredBullets: [], technologies: [] },
  ],
};

(async () => {
  const result = await llm.generateTailoredSelection(repos, JD, {
    apiKey: "test-key",
    fetchImpl: fakeFetch(canned),
  });

  assert.strictEqual(result.selectedProjects.length, 4, "projects clamped to 4");
  assert.strictEqual(result.selectedProjects[0].tailoredBullets.length, 3, "bullets clamped to 3");
  assert.deepStrictEqual(result.matchedSkills, ["React", "TypeScript", "REST APIs"]);
  ok("LLM layer parses + clamps (<=4 projects, <=3 bullets)");

  // robustness: fenced ```json wrapper still parses
  const fenced = "```json\n" + JSON.stringify(canned) + "\n```";
  assert.ok(llm.parseLlmJson(fenced).selectedProjects.length === 5);
  ok("parseLlmJson strips ``` code fences");

  // missing key -> typed config error
  await assert.rejects(
    () => llm.generateTailoredSelection(repos, JD, { fetchImpl: fakeFetch(canned), apiKey: "" }),
    (e) => e.name === "LLMError" && e.kind === "config"
  );
  ok("missing API key throws typed config error");

  /* ---- Phase 3: LaTeX escaping + generation ---- */
  assert.strictEqual(latex.escapeLatex("Backend & Frontend"), "Backend \\& Frontend");
  assert.strictEqual(latex.escapeLatex("my_database_project"), "my\\_database\\_project");
  assert.strictEqual(latex.escapeLatex("100% #1 $5 a^b ~c"), "100\\% \\#1 \\$5 a\\textasciicircum{}b \\textasciitilde{}c");
  assert.strictEqual(latex.escapeLatex("a\\b"), "a\\textbackslash{}b");
  ok("escapeLatex handles all reserved chars without double-escaping");

  const tex = latex.generateLatexResume({
    name: "Ada Lovelace",
    contactInfo: { email: "ada@x.com", linkedin: "linkedin.com/in/ada_l", github: "github.com/ada" },
    education: { college: "Trinity College", degree: "B.Sc. C&O", graduationYear: "2026", gpa: "9.1" },
    matchedSkills: ["React", "Node.js", "C++"],
    selectedProjects: [
      { name: "data_pipeline", description: "ETL in Python", tailoredBullets: ["Built X & Y by doing Z", "100% test coverage"], technologies: ["Python", "PostgreSQL"] },
    ],
  });

  assert.ok(tex.includes("\\documentclass[letterpaper,11pt]{article}"), "has preamble");
  assert.ok(tex.includes("\\end{document}"), "has end");
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(tex), "no unfilled {{PLACEHOLDER}} tags remain");
  assert.ok(tex.includes("Ada Lovelace"), "name injected");
  assert.ok(tex.includes("data\\_pipeline"), "project name escaped");
  assert.ok(tex.includes("Built X \\& Y by doing Z"), "bullet escaped");
  assert.ok(tex.includes("C\\&O"), "education escaped");
  ok("generateLatexResume produces a complete, escaped .tex with no leftover tags");

  /* ---- Phase 4: full pipeline with one fake fetch (no network) ---- */
  const jsonRes = (obj) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => obj, text: async () => JSON.stringify(obj),
  });
  const pipelineFetch = async (url) => {
    if (url.includes("api.github.com") && url.includes("/repos?")) {
      return jsonRes([
        { id: 1, name: "react-dashboard", description: "Analytics dashboard in React + TypeScript", stargazers_count: 42, language: "TypeScript", topics: ["react"], updated_at: "2026-04-01T00:00:00Z", owner: { login: "ada" }, fork: false, html_url: "https://github.com/ada/react-dashboard" },
        { id: 2, name: "flask-api", description: "REST API in Python", stargazers_count: 10, language: "Python", topics: ["api"], updated_at: "2025-01-01T00:00:00Z", owner: { login: "ada" }, fork: false },
        { id: 3, name: "forked-thing", description: "a fork", stargazers_count: 99, language: "Go", topics: [], updated_at: "2026-01-01T00:00:00Z", owner: { login: "ada" }, fork: true },
      ]);
    }
    if (url.includes("api.github.com") && url.includes("/languages")) return jsonRes({ TypeScript: 1000, CSS: 200 });
    if (url.includes("generativelanguage.googleapis.com")) {
      return jsonRes({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        matchedSkills: ["React", "TypeScript"],
        selectedProjects: [{ name: "react-dashboard", description: "Analytics dashboard", tailoredBullets: ["Built a React + TS dashboard"], technologies: ["React", "TypeScript"], reason: "Direct match on React & TypeScript." }],
      }) }] } }] });
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "unmocked " + url };
  };

  const out = await pipeline.generateTailoredResume(
    { githubUsername: "ada", jobDescription: JD, personalDetails: { name: "Ada Lovelace", email: "ada@x.com", college: "Trinity", graduation_year: "2026", gpa: "9.1" } },
    { apiKey: "test", fetchImpl: pipelineFetch }
  );

  assert.ok(out.latex.includes("\\documentclass"), "pipeline produced LaTeX");
  assert.ok(out.latex.includes("Ada Lovelace"), "personal details merged in");
  assert.ok(out.consideredRepos.every((r) => r.name !== "forked-thing"), "forks excluded");
  assert.strictEqual(out.selection.selectedProjects[0].reason, "Direct match on React & TypeScript.", "AI reason surfaced for UI");
  ok("full pipeline (fetch -> prefilter -> LLM -> LaTeX) runs end-to-end");

  console.log(`\nAll ${passed} checks passed.`);
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
