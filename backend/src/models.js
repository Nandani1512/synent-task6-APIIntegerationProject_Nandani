/* ============================================================
   JD -> LaTeX Resume Matcher — src/models.js
   Data models + normalizers (Phase 1).

   No-build project, so "type safety" comes from JSDoc @typedefs
   plus small normalizer factories that guarantee object SHAPE at
   runtime (every field present, correct type, sane default).
   Every downstream stage (prefilter -> LLM -> LaTeX) consumes
   these exact shapes.
   ============================================================ */
"use strict";

/* ============================================================
   TYPEDEFS
   ============================================================ */

/**
 * Normalized GitHub repository metadata — the only repo shape the rest of
 * the pipeline sees. Derived from the raw GitHub REST repo object (+ optional
 * per-repo language byte map).
 *
 * @typedef {Object} GithubRepoMetadata
 * @property {number}   id
 * @property {string}   name
 * @property {string}   description
 * @property {number}   stargazers
 * @property {string[]} languages    Languages used, most-used first.
 * @property {string[]} topics
 * @property {string}   updatedAt     ISO-8601 timestamp.
 * @property {string}   [url]
 * @property {string}   [homepage]
 * @property {number}   [forks]
 */

/**
 * Heuristic Phase-1 view of a Job Description.
 *
 * @typedef {Object} JobDescriptionProfile
 * @property {string[]} extractedKeywords
 * @property {string}   primaryRole
 * @property {string[]} technicalSkillsDemanded
 */

/**
 * @typedef {Object} EducationInfo
 * @property {string} college
 * @property {string} degree
 * @property {string} graduationYear
 * @property {string} gpa
 */

/**
 * @typedef {Object} ContactInfo
 * @property {string} email
 * @property {string} phone
 * @property {string} linkedin
 * @property {string} github
 * @property {string} [portfolio]
 */

/**
 * One project selected & tailored for the target JD. `tailoredBullets` are
 * X-Y-Z achievement bullets written by the LLM from repo facts only.
 *
 * @typedef {Object} SelectedProject
 * @property {string}   name
 * @property {string}   description
 * @property {string[]} tailoredBullets
 * @property {string[]} technologies
 */

/**
 * Full payload driving LaTeX generation. The LLM is responsible for
 * `matchedSkills` + `selectedProjects`; `name`/`contactInfo`/`education`
 * are merged in by the pipeline from the user's personal details.
 *
 * @typedef {Object} TailoredResumeData
 * @property {string}            name
 * @property {ContactInfo}       contactInfo
 * @property {EducationInfo}     education
 * @property {string[]}          matchedSkills
 * @property {SelectedProject[]} selectedProjects
 */

/* ============================================================
   COERCION HELPERS
   ============================================================ */

/** Coerce anything to a trimmed string ("" for null/undefined). */
function str(v) {
  return v == null ? "" : String(v).trim();
}

/** Coerce anything to a finite number (fallback 0). */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Coerce to a clean string[] — accepts arrays or comma-separated strings. */
function strList(v) {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/* ============================================================
   NORMALIZERS  (raw -> typed shape)
   ============================================================ */

/**
 * Normalize a raw GitHub REST repo object into GithubRepoMetadata.
 * `languageMap` is the optional `/repos/:o/:r/languages` byte map; when
 * present its keys (sorted by bytes) become `languages`, else we fall back
 * to `repo.language`.
 *
 * @param {Record<string, any>} repo
 * @param {Record<string, number>} [languageMap]
 * @returns {GithubRepoMetadata}
 */
function toRepoMetadata(repo, languageMap) {
  repo = repo || {};

  let languages;
  if (languageMap && typeof languageMap === "object") {
    languages = Object.entries(languageMap)
      .sort((a, b) => num(b[1]) - num(a[1]))
      .map(([k]) => k);
  }
  if (!languages || !languages.length) {
    languages = repo.language ? [String(repo.language)] : [];
  }

  return {
    id: num(repo.id),
    name: str(repo.name),
    description: str(repo.description),
    stargazers: num(repo.stargazers_count),
    languages,
    topics: strList(repo.topics),
    updatedAt: str(repo.updated_at || repo.pushed_at),
    url: str(repo.html_url),
    homepage: str(repo.homepage),
    forks: num(repo.forks_count),
  };
}

/**
 * @param {Record<string, any>} [raw]
 * @returns {EducationInfo}
 */
function toEducationInfo(raw) {
  raw = raw || {};
  return {
    college: str(raw.college),
    degree: str(raw.degree),
    graduationYear: str(raw.graduationYear ?? raw.graduation_year),
    gpa: str(raw.gpa ?? raw.GPA),
  };
}

/**
 * @param {Record<string, any>} [raw]
 * @returns {ContactInfo}
 */
function toContactInfo(raw) {
  raw = raw || {};
  return {
    email: str(raw.email),
    phone: str(raw.phone),
    linkedin: str(raw.linkedin),
    github: str(raw.github),
    portfolio: str(raw.portfolio),
  };
}

/**
 * @param {Record<string, any>} [raw]
 * @returns {SelectedProject}
 */
function toSelectedProject(raw) {
  raw = raw || {};
  return {
    name: str(raw.name),
    description: str(raw.description),
    tailoredBullets: strList(raw.tailoredBullets ?? raw.tailored_bullets ?? raw.bullets),
    technologies: strList(raw.technologies ?? raw.tech ?? raw.tech_stack),
    // one-line "why this fits the JD" — used by the UI, ignored by LaTeX.
    reason: str(raw.reason ?? raw.matchReason ?? raw.why),
  };
}

/**
 * Normalize partial/LLM data into a fully-formed TailoredResumeData.
 *
 * @param {Record<string, any>} [raw]
 * @returns {TailoredResumeData}
 */
function toTailoredResumeData(raw) {
  raw = raw || {};
  const projects = raw.selectedProjects ?? raw.selected_projects;
  return {
    name: str(raw.name),
    contactInfo: toContactInfo(raw.contactInfo ?? raw.contact_info),
    education: toEducationInfo(raw.education),
    matchedSkills: strList(raw.matchedSkills ?? raw.matched_skills),
    selectedProjects: (Array.isArray(projects) ? projects : []).map(toSelectedProject),
  };
}

module.exports = {
  str,
  num,
  strList,
  toRepoMetadata,
  toEducationInfo,
  toContactInfo,
  toSelectedProject,
  toTailoredResumeData,
};
