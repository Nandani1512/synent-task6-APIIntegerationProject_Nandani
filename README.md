# GitHub Dev Portfolio Generator

Enter any GitHub username and instantly generate a beautiful, shareable developer
portfolio — built with **vanilla HTML, CSS, and JavaScript** (Fetch API), no frameworks.

## Tech
- Vanilla JS only (no React/Vue) · GitHub REST API (no auth required for public data)
- Optional personal access token raises the rate limit from 60 → 5,000 req/hour
- Chart.js (CDN) for the commit-activity chart

## Files
| File | Purpose |
|------|---------|
| `index.html` | Markup and section containers |
| `style.css`  | Layout, theme variables, skeletons, print styles |
| `script.js`  | Fetch logic, DOM rendering, event handlers |

## Build phases
This project was built in 5 incremental phases (one git commit each):

1. **Foundation** — scaffold, GitHub fetch layer (`Promise.all`), hero section, dark/light theme, debounced input, `?user=` URL param
2. **Stats & Skills** — stat cards with animated counters, language detection + skill bars
3. **Repos & Caching** — repo cards, interactive pin/unpin (sessionStorage), session caching
4. **Activity** — contribution heatmap, streak counters, commit chart, activity feed
5. **Export & Polish** — share link, PDF export + print styles, rate-limit UI, full error states

## Run
Open `index.html` in a browser, or serve the folder:

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

Try `?user=torvalds` in the URL to auto-load a profile.

## Using a GitHub token (optional, raises rate limit 60 → 5,000/hour)

This is a **pure HTML/JS project with no build tool**, so there is no `.env`
support. A token is **never hardcoded** in committed source. Choose one:

1. **At runtime (simplest):** click the **🔑** button in the top bar, paste your
   token, and Save. It is stored only in `sessionStorage` for that browser tab.
2. **Locally, without re-typing:** copy `config.local.example.js` to
   `config.local.js` and paste your token there. `config.local.js` is listed in
   `.gitignore`, so it is **never committed or pushed**.

> 🔒 **Security:** never commit a real token, and never paste one into a public
> chat, screenshot, or issue. If a token is ever exposed, revoke it immediately
> at https://github.com/settings/tokens and generate a new one. Tokens for this
> app need **no scopes** (public data only).

