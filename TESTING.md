# Testing Checklist — GitHub Dev Portfolio Generator

A manual test plan covering every section, feature, and error state. Open
`index.html` in a browser (or `python -m http.server 8000`) and work through it.

> Tip: keep DevTools open (F12) → **Console** tab (to catch JS errors) and
> **Network** tab (to watch the parallel requests and response headers).

---

## 0. Setup
- [ ] Page loads with **no red errors** in the Console.
- [ ] Top bar shows the brand, the API rate-limit pill, the 🔑 button, and the theme toggle.
- [ ] (If `config.local.js` has your token) the rate-limit pill reads close to **5000** after the first search; without a token it starts near **60**.

## 1. Hero + fetch
- [ ] Type a valid username (e.g. `torvalds`) and press **Generate**.
- [ ] A **loading skeleton** appears on the hero and the body while fetching.
- [ ] Avatar, name, `@login`, bio, location, "Joined <year>", and the GitHub link all render.
- [ ] In the **Network** tab, `users`, `repos`, and `events` requests fire **in parallel** (overlapping bars), not one-after-another.

## 2. Stats bar
- [ ] Four cards show Repositories, Stars Earned, Followers, Following.
- [ ] Numbers **count up from 0** (animated), not snap instantly.
- [ ] Stars total looks plausible (sum across repos).

## 3. Skills
- [ ] Up to **8 language bars** render, sorted by usage.
- [ ] Percentages add up sensibly and bars **animate** their width in.
- [ ] Each language has a distinct color.

## 4. Repositories + pin/unpin
- [ ] Repo cards show name, description, ⭐ stars, ⑂ forks, and a colored language badge.
- [ ] Click 📍 on a card → it becomes 📌, gets a "Pinned" label + accent ring, and **moves to the top**.
- [ ] Click 📌 again → it unpins.
- [ ] Pin a repo, then **reload the page** with the same `?user=` → the pin **persists** (sessionStorage).
- [ ] Open a **new tab** → pins are gone there (session-scoped, as expected).

## 5. Contribution heatmap
- [ ] A grid of small squares renders (7 rows × up to 53 columns).
- [ ] Squares have **varying green intensities** based on activity.
- [ ] **Hover** a square → a tooltip shows the date and "N push events".
- [ ] The legend (Less → More) appears under the grid.

## 6. Streaks
- [ ] "Current Streak" and "Longest Streak" cards show numbers (count up).
- [ ] Values are 0+ and don't error for users with no recent pushes.

## 7. Commit activity chart
- [ ] A **bar chart** renders (Chart.js) for the last 30 days.
- [ ] Hovering bars shows a tooltip with the date + commit count.
- [ ] Toggling the theme **redraws** the chart in the new theme's colors.

## 8. Recent activity feed
- [ ] Up to **10 events** list with an icon, a verb (pushed to / starred / forked…), and a repo link.
- [ ] Timestamps read as **"3 hours ago" / "2 days ago"** etc. (relative), not raw dates.

## 9. Theme toggle
- [ ] Clicking 🌙 / ☀️ flips between dark and light across the **whole page**.
- [ ] Choice **persists** on reload (sessionStorage).

## 10. sessionStorage caching
- [ ] Search a user, then search a **different** user, then search the **first** user again.
- [ ] The repeat shows a **"Loaded from session cache"** toast and makes **no new network requests** (verify in Network tab).

## 11. Debounced input
- [ ] Type a username **character by character**; the app waits ~300ms after you stop before firing (it does **not** fire a request per keystroke).

## 12. Rate-limit indicator
- [ ] The pill updates after each search to show remaining requests.
- [ ] When it gets low (≤5) it turns **red**.

## 13. Token panel
- [ ] Click 🔑 → panel opens with a password input.
- [ ] Save a token → toast confirms, panel closes, and the current profile re-fetches at the higher limit.
- [ ] Clear → token removed.

## 14. Share link
- [ ] Click **🔗 Copy Shareable Link** → button flashes **"✓ Copied!"** and a toast appears.
- [ ] Paste the link in a new tab → it has `?user=<name>` and **auto-generates** the portfolio on load.

## 15. PDF export / print
- [ ] Click **🖨️ Export as PDF** → the browser print dialog opens.
- [ ] In the print preview: the top bar, search box, buttons, theme toggle, pins, and footer are **hidden**; the layout is **light** and clean.
- [ ] Save as PDF → it's readable and well laid out.

## 16. Error states  ← test all three
- [ ] **404 – user not found:** search a nonsense name like `zzzz_no_such_user_zzzz` → "User not found" panel with a **Retry** button.
- [ ] **403 – rate limit:** without a token, do several searches until the limit hits → "Rate limit reached" panel pointing at the 🔑 button.
- [ ] **Network failure:** open DevTools → Network → set throttling to **Offline**, then search → "Network error" panel. Set back to **Online** and click **Retry** → it recovers.

## 17. Responsive layout
- [ ] DevTools → device toolbar (Ctrl/Cmd+Shift+M) → switch to a phone width.
- [ ] Stats collapse to 2 columns; skills/repos go to 1 column; hero stacks; the heatmap scrolls horizontally. Nothing overflows or overlaps.

## 18. Security sanity
- [ ] `git status` does **not** list `config.local.js`.
- [ ] No real token appears anywhere in `index.html`, `style.css`, `script.js`, or `config.local.example.js`.

---

### Known limitations (mention these in your write-up — shows awareness)
- GitHub's public-events API returns only the **last ~90 days / 300 events**, so the heatmap and streaks reflect recent activity, not a full year.
- Language percentages are tallied from the **top 8 starred repos** (to stay within the rate limit); remaining repos contribute via their primary language only.
- Unauthenticated limit is **60 requests/hour**; add a token for **5,000/hour**.
