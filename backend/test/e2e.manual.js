/* One real end-to-end call against a running server on :3000.
   Proves the surgical-injection contract: everything OUTSIDE the
   AI_PROJECTS markers is byte-for-byte identical after tailoring.
   Usage:  node test/e2e.manual.js <github_username>
   (needs GEMINI_API_KEY in backend/.env and network access) */
"use strict";
const assert = require("assert");

const username = process.argv[2] || "Nandani1512";

const HEADER_EDU_SKILLS = [
  "\\documentclass[letterpaper,11pt]{article}",
  "\\begin{document}",
  "\\begin{center}{\\Large \\textbf{Ada Lovelace}} \\\\ ada@example.com $|$ github.com/ada\\end{center}",
  "\\section*{Education}",
  "Trinity College \\hfill 2026 \\\\ B.Sc. Computer Science \\hfill GPA: 9.1/10",
  "\\section*{Technical Skills}",
  "Python, JavaScript, C++  % <- this line must survive untouched",
  "\\section*{Projects}",
  "\\begin{itemize}",
].join("\n");

const FOOTER = ["\\end{itemize}", "\\end{document}"].join("\n");

const START = "% --- AI_PROJECTS_START --- %";
const END = "% --- AI_PROJECTS_END --- %";

// Two original projects so we can see the keep-relevant / replace-weak behavior.
const ORIGINAL_PROJECTS =
  "  \\item \\textbf{tetris-clone} A browser Tetris game in vanilla JS\n" +
  "  \\item \\textbf{recipe-notes} A small notes app";

const template =
  HEADER_EDU_SKILLS + "\n" + START + "\n" + ORIGINAL_PROJECTS + "\n" + END + "\n" + FOOTER;

(async () => {
  const res = await fetch("http://localhost:3000/api/resume/tailor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      github_username: username,
      job_description:
        "Backend engineer: Python, REST APIs, databases, Docker. JavaScript a plus.",
      latex_template: template,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(`Server returned ${res.status} (${data.kind}): ${data.error}`);
    process.exit(1);
  }

  const out = data.latex;

  // 1. Everything BEFORE the start marker is unchanged (header/education/skills).
  const before = out.slice(0, out.indexOf(START) + START.length);
  assert.strictEqual(
    before,
    HEADER_EDU_SKILLS + "\n" + START,
    "text before the START marker was modified!"
  );

  // 2. Everything AFTER the end marker is unchanged (footer).
  const after = out.slice(out.indexOf(END));
  assert.strictEqual(after, END + "\n" + FOOTER, "text after the END marker was modified!");

  // 3. The skills line survived verbatim.
  assert.ok(
    out.includes("Python, JavaScript, C++  % <- this line must survive untouched"),
    "the skills line was altered!"
  );

  // 4. There are still \item projects in the region.
  assert.ok(out.includes("\\item"), "no project items in the region");

  // 5. Skill suggestions are returned (add/remove).
  assert.ok(Array.isArray(data.skillsToAdd) && Array.isArray(data.skillsToRemove), "skill suggestions missing");

  const actions = (data.selectedProjects || []).map((p) => `${p.name} [${p.action}]`);
  console.log(`OK — surgical region rewrite verified for @${username}`);
  console.log(`   projects: ${actions.join(", ") || "—"}`);
  console.log(`   skills to add: ${data.skillsToAdd.join(", ") || "—"}`);
  console.log(`   skills to remove: ${data.skillsToRemove.join(", ") || "—"}`);
  console.log(`   header/education/skills/footer: byte-for-byte unchanged ✅`);
})().catch((e) => {
  console.error("E2E FAILED:", e.message);
  process.exit(1);
});
