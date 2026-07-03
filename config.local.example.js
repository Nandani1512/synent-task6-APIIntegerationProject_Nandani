// =====================================================================
//  config.local.example.js   —  TEMPLATE (safe to commit)
// =====================================================================
//  To use a GitHub personal access token locally (raises the API rate
//  limit from 60 to 5,000 requests/hour):
//
//    1. Copy this file to  config.local.js   (which is gitignored)
//    2. Paste YOUR OWN token between the quotes below
//    3. Reload the page
//
//  Generate a token at https://github.com/settings/tokens
//  ("Generate new token (classic)" — no scopes needed for public data).
//
//  NEVER put a real token in this example file or commit config.local.js.
//  The app also lets you paste a token at runtime via the 🔑 button.
// =====================================================================

sessionStorage.setItem("ghpf_token", "PASTE_YOUR_TOKEN_HERE");

// ---------------------------------------------------------------------
//  AI Resume Tailor backend (JD -> LaTeX). Defaults to http://localhost:3000.
//  Uncomment + set this to point the frontend at a deployed backend:
// ---------------------------------------------------------------------
// window.BACKEND_URL = "https://your-backend.onrender.com";
