---
name: searchd-dashboard
description: Build and open searchd's local dashboard, one self-contained HTML file with the user's App Store keyword data — a keyword × country rank board, keyword volume and difficulty with the top 5 apps, competitors they're losing to, brainstorm ideas, and rank history charts. Use when the user runs /searchd-dashboard or wants to see their searchd results visually.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/dashboard.js *)
---

# searchd dashboard

`${CLAUDE_SKILL_DIR}` is this skill's folder (the one containing this SKILL.md); if your agent doesn't fill it in, use that folder's path. Run commands **from the user's current folder** (don't `cd`): the data is in `.searchd/` there.

## Steps
1. Run `node ${CLAUDE_SKILL_DIR}/scripts/dashboard.js` (add `--no-open` if the user doesn't want a browser tab opened). It writes `.searchd/dashboard.html` and opens it.
   - "isn't set up" → suggest /searchd-setup. "No results yet" → suggest /searchd-find.
2. Tell the user the file path it printed and what's in each tab:
   - **Board:** every keyword × country rank (🥇🥈🥉 for 1–3, ▲▼ = change since the previous check).
   - **Keywords:** per country, the local phrase, rank, volume, difficulty, opportunity, and the top 5 apps (theirs is outlined).
   - **Competitors:** the apps that beat them in the most checks, and a head-to-head with the competitors from setup.
   - **Ideas:** brainstormed keywords, best opportunity first, with ⭐ sweet spots.
   - **History:** rank over time per tracked keyword (needs /searchd-track on more than one day).
3. Mention that it's a snapshot: run /searchd-dashboard again after new checks to refresh it. It's a plain local file: no server, nothing uploaded.
