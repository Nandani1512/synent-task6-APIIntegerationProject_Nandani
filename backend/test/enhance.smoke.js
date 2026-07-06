/* Offline smoke for the JD-driven enhancement layer (src/enhance.js).
   No network, no API key. Run: node test/enhance.smoke.js  (from backend/) */
"use strict";

const assert = require("assert");
const enhance = require("../src/enhance");

let passed = 0;
const ok = (label) => { console.log("  ok -", label); passed++; };

/* ---- normalizeEnhancement: clamps + defaults + shape guarantees ---- */
const messy = enhance.normalizeEnhancement({
  summary: "  Decent fit, missing cloud depth.  ",
  keywordMatch: {
    matchPercent: 142,                       // out of range -> clamp to 100
    matchedKeywords: ["React", "", "Node"],  // blanks dropped
    missingKeywords: "Docker, Kubernetes",   // comma string -> array
  },
  strengths: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"], // > MAX -> truncated to 6
  gaps: [
    { gap: "No cloud experience", severity: "CRITICAL", fix: "Add the AWS project." }, // bad severity -> medium
    { gap: "", severity: "high", fix: "dropped (no gap text)" },                        // dropped
  ],
  bulletRewrites: [
    { original: "Worked on backend", suggested: "Built REST API serving 5 endpoints", why: "action verb + result" },
    { original: "", suggested: "dropped", why: "no original" },   // dropped
    { original: "has original", suggested: "", why: "no suggestion" }, // dropped
  ],
  atsIssues: [
    { issue: "Uses '&' instead of 'and'", fix: "Replace & with and" },
    { issue: "", fix: "dropped" }, // dropped
  ],
  skills_to_add: ["Docker"],       // snake_case accepted
  skills_to_remove: ["jQuery"],
});

assert.strictEqual(messy.summary, "Decent fit, missing cloud depth.", "summary trimmed");
assert.strictEqual(messy.keywordMatch.matchPercent, 100, "matchPercent clamped to 100");
assert.deepStrictEqual(messy.keywordMatch.matchedKeywords, ["React", "Node"], "blank keyword dropped");
assert.deepStrictEqual(messy.keywordMatch.missingKeywords, ["Docker", "Kubernetes"], "comma string -> array");
assert.strictEqual(messy.strengths.length, 6, "strengths capped at MAX_STRENGTHS");
assert.strictEqual(messy.gaps.length, 1, "gap with empty text dropped");
assert.strictEqual(messy.gaps[0].severity, "medium", "unknown severity normalized to medium");
assert.strictEqual(messy.bulletRewrites.length, 1, "rewrites need both original + suggested");
assert.strictEqual(messy.atsIssues.length, 1, "ats issue with empty issue dropped");
assert.deepStrictEqual(messy.skillsToAdd, ["Docker"], "snake_case skills_to_add accepted");
assert.deepStrictEqual(messy.skillsToRemove, ["jQuery"], "snake_case skills_to_remove accepted");
ok("normalizeEnhancement clamps, defaults, de-duplicates shape");

/* negative / missing values default safely */
const empty = enhance.normalizeEnhancement({ keywordMatch: { matchPercent: -5 } });
assert.strictEqual(empty.keywordMatch.matchPercent, 0, "negative matchPercent clamped to 0");
assert.deepStrictEqual(empty.strengths, [], "missing arrays default to []");
assert.deepStrictEqual(empty.gaps, [], "missing gaps default to []");
ok("normalizeEnhancement handles missing/negative fields");

/* ---- prompt builder includes both the JD and the resume ---- */
const prompt = enhance.buildEnhancePrompt("Built a React dashboard.", "Frontend role: React, Docker.");
assert.ok(prompt.includes("Built a React dashboard."), "resume text present in prompt");
assert.ok(prompt.includes("Frontend role: React, Docker."), "JD present in prompt");
ok("buildEnhancePrompt embeds resume + JD");

/* ---- enhanceResume end-to-end with a fake Gemini fetch ---- */
const jsonRes = (obj) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => obj, text: async () => JSON.stringify(obj),
});

const geminiFetch = async (url) => {
  if (url.includes("generativelanguage.googleapis.com")) {
    return jsonRes({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      summary: "Strong React fit; add Docker evidence.",
      keywordMatch: { matchPercent: 70, matchedKeywords: ["React", "TypeScript"], missingKeywords: ["Docker"] },
      strengths: ["Shipped a deployed React dashboard (live URL)."],
      gaps: [{ gap: "No containerization shown", severity: "medium", fix: "Mention the Docker deploy from your dashboard repo." }],
      bulletRewrites: [{ original: "Worked on the dashboard UI", suggested: "Built a responsive React dashboard used by 200+ users", why: "Adds an action verb and a measurable result." }],
      atsIssues: [{ issue: "Bullet opens with 'Worked on'", fix: "Start with a strong action verb like 'Built'." }],
      skillsToAdd: ["Docker"],
      skillsToRemove: ["jQuery"],
    }) }] } }] });
  }
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
};

(async () => {
  const result = await enhance.enhanceResume(
    "EXPERIENCE\nWorked on the dashboard UI in React and TypeScript.",
    "Frontend Developer: React, TypeScript, Docker.",
    { apiKey: "test", fetchImpl: geminiFetch }
  );

  assert.strictEqual(result.keywordMatch.matchPercent, 70, "match percent surfaced");
  assert.deepStrictEqual(result.keywordMatch.missingKeywords, ["Docker"], "missing keyword surfaced");
  assert.strictEqual(result.bulletRewrites[0].suggested.includes("Built"), true, "rewrite uses a strong verb");
  assert.strictEqual(result.gaps[0].severity, "medium", "gap severity preserved");
  assert.deepStrictEqual(result.skillsToAdd, ["Docker"]);
  ok("enhanceResume end-to-end (prompt -> fake Gemini -> normalized advice)");

  /* empty resume -> input error */
  await assert.rejects(
    () => enhance.enhanceResume("", "some JD", { apiKey: "test", fetchImpl: geminiFetch }),
    (e) => e.kind === "input"
  );
  /* empty JD -> input error */
  await assert.rejects(
    () => enhance.enhanceResume("some resume", "", { apiKey: "test", fetchImpl: geminiFetch }),
    (e) => e.kind === "input"
  );
  ok("enhanceResume rejects empty resume / JD with input errors");

  console.log(`\nAll ${passed} checks passed.`);
})().catch((e) => {
  console.error("ENHANCE SMOKE TEST FAILED:", e);
  process.exit(1);
});
