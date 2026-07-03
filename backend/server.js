/* ============================================================
   JD -> LaTeX Resume Matcher — server.js  (Phase 4)
   Thin Express HTTP layer over the pipeline.

   Endpoints:
     GET  /api/health           liveness + config sanity
     POST /api/resume/tailor    surgically inject tailored projects into
                                the user's own LaTeX template (BYOT)

   The Gemini key is read from the environment here and never sent to
   the client.
   ============================================================ */
"use strict";

require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { tailorTemplate } = require("./src/byotPipeline");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

// Serve the frontend static files (index.html, script.js, style.css, etc.)
// from the project root (one level up from backend/).
app.use(express.static(path.join(__dirname, "..")));

// CORS: "*" (default) allows any origin; otherwise a comma-separated allow-list.
const corsOrigins = String(process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins.includes("*") ? true : corsOrigins }));

// Rate-limit the AI tailor endpoint to protect the Gemini API quota.
const tailorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in a few minutes.", kind: "ratelimit" },
});

/* ---------- health ---------- */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    geminiKeyConfigured: !!process.env.GEMINI_API_KEY,
    githubTokenConfigured: !!process.env.GITHUB_TOKEN,
  });
});

/* ---------- Tailor endpoint (surgical, projects-only injection) ---------- */
app.post("/api/resume/tailor", tailorLimiter, async (req, res) => {
  const body = req.body || {};
  const githubUsername = body.github_username || body.githubUsername;
  const jobDescription = body.job_description || body.jobDescription;
  const latexTemplate = body.latex_template || body.latexTemplate;
  const wantsFile = body.format === "file" || "download" in req.query;

  // Input length validation — prevent prompt-stuffing / quota abuse.
  const MAX_JD_CHARS = 15_000;
  const MAX_LATEX_CHARS = 50_000;
  if (typeof jobDescription === "string" && jobDescription.length > MAX_JD_CHARS) {
    return res.status(400).json({ error: `Job description exceeds ${MAX_JD_CHARS} characters.`, kind: "input" });
  }
  if (typeof latexTemplate === "string" && latexTemplate.length > MAX_LATEX_CHARS) {
    return res.status(400).json({ error: `LaTeX template exceeds ${MAX_LATEX_CHARS} characters.`, kind: "input" });
  }

  try {
    const result = await tailorTemplate(
      { githubUsername, jobDescription, latexTemplate },
      {}
    );

    // Option A: download as a text/plain attachment named resume.tex
    if (wantsFile) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="resume.tex"');
      return res.send(result.latex);
    }

    // Option B (default): JSON so the UI can render the split-screen view
    return res.json({
      latex: result.latex,
      warnings: result.warnings,
      skillsToAdd: result.skillsToAdd,
      skillsToRemove: result.skillsToRemove,
      selectedProjects: result.selectedProjects,
      consideredRepos: result.consideredRepos,
    });
  } catch (err) {
    const status = err.status || mapStatus(err.kind);
    if (status >= 500) console.error("[tailor]", err);
    return res.status(status).json({ error: err.message || "Internal error", kind: err.kind || "error" });
  }
});

/** Map a domain error kind to an HTTP status. */
function mapStatus(kind) {
  switch (kind) {
    case "input":
      return 400;
    case "notfound":
      return 404;
    case "ratelimit":
      return 429;
    case "blocked":
    case "http":
      return 502;
    case "config":
      return 500;
    default:
      return 500;
  }
}

// Don't auto-listen when imported by a test.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`DevFolio resume backend listening on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
      console.warn("  WARNING: GEMINI_API_KEY is not set — /api/resume/tailor will fail until you add it to backend/.env");
    }
  });
}

module.exports = app;
