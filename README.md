# searchd

**Get your app searchd.** searchd is a free, open-source agent skill for [Claude Code](https://claude.com/claude-code) and Codex that does App Store keyword research for indie app developers.

It tells you:

- **where your app ranks** for each keyword in each country (🥇🥈🥉 for the top 3)
- **how much demand** a keyword seems to have, and **how hard** it is to rank for
- **the natural local phrase** for each keyword in each country ("calorie counter" → "kalorienzähler" in Germany)
- **which apps beat you** most often
- **new keyword ideas** worth going after, scored and sorted
- **a rewritten name, subtitle, and keyword field** for each language, with exact character counts
- **how your ranks change day by day**, so you can see whether a listing change worked

Your own AI agent does the thinking (brainstorming, translating, writing the listing). Apple's free search API supplies the data. There's no API key, no account, and no server, and all your data stays in a `.searchd/` folder in your project.

searchd is the sibling of [marKit](https://github.com/notsocj/markit). marKit finds people online to tell about your app (outbound). searchd helps people find your app in App Store search (inbound).

## Contents

- [Why ASO matters](#why-aso-matters)
- [How it works](#how-it-works)
- [Words searchd uses](#words-searchd-uses)
- [Requirements](#requirements) · [Install](#install) · [Quick start](#quick-start)
- [A real run, start to finish](#a-real-run-start-to-finish)
- [Commands in detail](#commands-in-detail)
- [The dashboard](#the-dashboard)
- [How the scores work](#how-the-scores-work)
- [Speed, rate limits, and reliability](#speed-rate-limits-and-reliability)
- [Your data](#your-data)
- [Running the scripts yourself](#running-the-scripts-yourself)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Privacy and safety](#privacy-and-safety)
- [Coming later](#coming-later) · [Development](#development) · [Credits](#credits) · [License](#license)

---

## Why ASO matters

Most App Store downloads start with a search. Apple decides which apps show up mainly from three fields you control:

| Field | Limit | Visible? | Weight |
|---|---|---|---|
| **App name** | 30 characters | yes | the strongest signal |
| **Subtitle** | 30 characters | yes | strong |
| **Keyword field** | 100 characters | no, only Apple sees it | used for matching |

Picking the right words for those fields, the ones people actually type and that you can realistically rank for, is App Store Optimization (ASO). It's free, and for a small app it's often the biggest growth lever there is. Paid ASO tools charge a monthly fee for this research; searchd does the core of it with your own agent and Apple's free data.

## How it works

```
/searchd-setup      your app (link, name, or ID) + countries + seed keywords + competitors
                                                                       → .searchd/app.json
/searchd-find
   ├─ your agent    brainstorms ideas and writes each keyword's local phrase per country
   ├─ find.js       searches the App Store for every keyword × country (throttled, cached),
   │                scores rank, volume, difficulty, opportunity       → .searchd/results.json
   └─ your agent    summarizes the best ideas and asks which to track

/searchd-track      re-checks tracked keywords, adds today to the history → .searchd/history/
/searchd-audit      your agent writes a new name / subtitle / keyword field per language;
                    audit.js enforces Apple's limits and rules           → .searchd/audit.json
/searchd-dashboard  builds one self-contained HTML file and opens it    → .searchd/dashboard.html
```

The split is deliberate: **scripts do everything that must be exact** (API calls, rate limiting, scoring, character counting, rule checks, saving), and **your agent does everything that needs language** (brainstorming, translating, writing). The scripts validate whatever the agent sends before saving it, so a typo or a bad translation format can't corrupt your data.

## Words searchd uses

| Word | Meaning |
|---|---|
| **keyword** | The idea you want to rank for, in English: "calorie counter". It groups the results across countries. |
| **local phrase** | What people actually type in one country: "kalorienzähler" in 🇩🇪, "カロリー計算" in 🇯🇵. This is what gets searched. |
| **check** | One App Store search: one keyword's local phrase in one country. Every number comes from checks. |
| **tracked** | A keyword you care about. `/searchd-track` re-checks these daily. Your seeds start as tracked. |
| **idea** | A brainstormed keyword. Checked once by `/searchd-find`; you choose which ones to track. |
| **rank** | Your position in that search: 1 is first, **200+** means you're not in Apple's top 200. |
| **volume** | 0–100 estimate of demand. Not a real search count. |
| **difficulty** | 0–100 estimate of how hard it is to reach the top 10. |
| **opportunity** | Volume discounted by difficulty: demand you can realistically win. |
| **⭐ sweet spot** | Volume ≥ 20 and difficulty ≤ 55: worth targeting. |

## Requirements

- [Node.js](https://nodejs.org) **18 or newer**
- Claude Code or Codex

## Install

**Recommended:** with the open [`skills`](https://skills.sh) installer (works for Claude Code, Codex, and other agents):

```bash
npx skills add https://github.com/notsocj/searchd --skill
```

It installs all five skills (searchd-setup, searchd-find, searchd-track, searchd-audit, searchd-dashboard), which share code, so they always go together. Then it asks a few questions:

- **Which agents:** pick Claude Code, Codex, or both.
- **Scope:** pick **Global**, so searchd works in every project, not just the folder you ran the installer in.
- **Method:** pick **Symlink (Recommended)**.

**Update:** `npx skills update -g`. **Remove:** `npx skills remove -g searchd-setup searchd-find searchd-track searchd-audit searchd-dashboard`.

Start a new agent session afterwards so it sees the skills.

**Alternative: from a clone,** with no npm tools at all:

```bash
git clone https://github.com/notsocj/searchd.git
cd searchd
./install.sh
```

| Command | Installs to |
|---|---|
| `./install.sh` | Claude Code, for your user (`~/.claude/skills`) |
| `./install.sh --codex` | Codex, for your user (`~/.agents/skills`) |
| `./install.sh --claude --codex` | both |
| `./install.sh --project` | Claude Code, current project only (`./.claude/skills`) |
| `./install.sh --dir <path>` | any skills folder |
| `./install.sh --link` | symlinks to the clone (for developing searchd) |
| `./install.sh --uninstall` | removes the skills (your `.searchd/` data stays) |

`install.sh` only copies files.

## Quick start

Open your agent **in your app's project folder** (searchd saves its data there), then:

1. **`/searchd-setup`**: give it your App Store link, name, or app ID; pick countries; add 3–5 seed keywords.
2. **`/searchd-find`**: brainstorms ideas, translates everything per country, checks it all, and tells you what's worth targeting.
3. **`/searchd-dashboard`**: see it all.
4. **`/searchd-audit`**: get a rewritten listing per language.
5. **`/searchd-track`**: once a day, especially after a listing change.

In Codex, use `$searchd-setup`, `$searchd-find`, and so on.

## A real run, start to finish

This is a real run (October 2026) for a public app, Structured: Daily Planner, across all 10 default countries. The output is shortened; the numbers are real.

**1. Setup.** Asked for "structured daily planner", searchd showed the top 5 App Store matches; Structured was #1. Seeds: daily planner, time blocking, visual timeline, adhd planner. Competitors: Tiimo and TickTick.

```
Saved Structured: Daily Planner Todo (1499198946), 10 countries (us, gb, ca, au, ph, de, fr, jp, es, br), 4 keywords
Added .searchd/ to .gitignore.
```

**2. Find.** The agent read the app's description, brainstormed 7 ideas (to do list, routine planner, habit tracker, focus timer…), and localized all 11 keywords into 10 countries ("to do list" → 🇩🇪 "to do liste", 🇫🇷 "liste de tâches", 🇯🇵 "やることリスト", 🇧🇷 "lista de tarefas"). Then:

```
110 checks (110 new today, about 7 min).
1/110 · 🇺🇸 daily planner → #1 · vol 54 · diff 72
…
110/110 · 🇧🇷 produtividade → #10 · vol 11 · diff 68
Done: 110 checked.
```

110 searches took about 8 minutes with no failures. The summary, best opportunity first (the phrase is shown where it differs from the keyword):

```
habit tracker [idea]: 🇺🇸 #12 v80 d71 | 🇬🇧 #6 v78 d53⭐ | 🇵🇭 #4 v83 d42⭐ | 🇩🇪 gewohnheitstracker #2 v72 d47⭐ | 🇫🇷 suivi des habitudes 200+ v54 d41⭐ | 🇪🇸 rastreador de hábitos 200+ v59 d20⭐ | …
adhd planner [tracked]: 🇺🇸 #1 v45 d73 | 🇬🇧 #1 v37 d49⭐ | 🇩🇪 adhs planer #1 v35 d39⭐ | 🇫🇷 planificateur tdah #8 v38 d20⭐ | 🇪🇸 planificador tdah #7 v40 d13⭐ | …
daily planner [tracked]: 🇺🇸 #1 v54 d72 | 🇩🇪 tagesplaner #1 v50 d54⭐ | 🇫🇷 planificateur quotidien #1 v23 d49⭐ | 🇯🇵 スケジュール帳 #49 v39 d76 | …
```

What that tells you: Structured already owns "daily planner" and "adhd planner" almost everywhere, but **"habit tracker" is a sweet spot in most countries** (high volume, beatable difficulty), and Structured doesn't rank at all for it in 🇫🇷 and 🇪🇸. That's the next keyword to target. Japan is the weak market: 200+ for most phrases.

**3. Audit.** The agent wrote a listing per language and `audit.js` checked it. On the first try it caught a real mistake: "agenda" was in both the pt-BR subtitle and the keyword field.

```
pt-BR (BR)
  name      ✓  26/30  Structured: Planner Diário
  subtitle  ✓  30/30  Rastreador de Hábitos e Agenda
  keywords  ✓  91/100  tdah,rotina,lista,tarefas,timer,pomodoro,calendário,produtividade,linha,tempo,blocos,agenda

Not saved. Fix these:
- pt-BR: "agenda" is already in the name or subtitle
```

**4. Track.** The same day it's instant (everything is cached). From the next day on, it shows what moved:

```
Done: 40 checked.
Top 3 in 23 of 40 checks: 🥇 18 · 🥈 4 · 🥉 1
```

**5. Dashboard.** One 174 KB HTML file with all of the above. In "Losing to", the apps beating Structured most often were Calendars (15 of 110 checks), Habit Tracker (13), and Forest (11). Head to head, Structured was 🥇 for "daily planner" in the US, where TickTick was #5 and Tiimo #37.

## Commands in detail

### `/searchd-setup [app]`

Sets up searchd for one app in the current folder.

1. **Finds your app.** Give it any of these:
   - an App Store link: `https://apps.apple.com/us/app/…/id1499198946`, old `itunes.apple.com` links, links without a country, or `itms-apps://` links
   - the numeric app ID: `1499198946` (or `id1499198946`)
   - the app's name: searchd shows the top 5 matches and you pick yours
2. **Countries:** 2-letter codes. Default: 🇺🇸 US, 🇬🇧 GB, 🇨🇦 CA, 🇦🇺 AU, 🇵🇭 PH, 🇩🇪 DE, 🇫🇷 FR, 🇯🇵 JP, 🇪🇸 ES, 🇧🇷 BR. Each country adds one check per keyword, so fewer countries means faster runs.
3. **Seed keywords:** 3–5 phrases you want to be found for, in English. Your agent suggests some from your app's description.
4. **Competitors (optional):** apps to compare against head to head. Found by name or link, like your app.

It saves `.searchd/app.json` and `.searchd/keywords.json`, and adds `.searchd/` to your project's `.gitignore` if it has one.

Running it again later updates the countries and competitors and adds new seeds; everything already saved is kept. **Switching to a different app** moves the old app's keywords, results, and history to `.searchd/archive/<old app ID>-<date>/`, so two apps' numbers never mix.

### `/searchd-find [topic]`

The main research command.

1. **Brainstorms 15–25 keyword ideas** from your app's App Store description, your seeds, and anything you add (`/searchd-find focus and study`). Ideas are short phrases people really type, without competitor brand names or filler like "app" and "best".
2. **Localizes every keyword for every country.** Your agent writes the phrase a native speaker would type, not a word-for-word translation: "to do list" becomes "lista de tarefas" in 🇧🇷 and "やることリスト" in 🇯🇵. English-speaking countries keep English, and countries that search the English term (common in tech and fitness) get the English term. Phrases are cleaned the same way app names are read (lowercase, no emoji or symbols), so what's searched is exactly what's scored.
3. **Checks everything:** one App Store search per keyword per country, with progress lines:

   ```
   110 checks (110 new today, about 7 min).
   1/110 · 🇺🇸 daily planner → #1 · vol 54 · diff 72
   ```

4. **Summarizes:** the top 25 keywords by opportunity, each country's rank, volume, difficulty, and ⭐ sweet spots. Your agent tells you your best ranks, the best ideas, the ones to drop, and asks which ideas to track.

Long runs go to the background (in Claude Code) and can be stopped and resumed at any time.

### `/searchd-track`

Re-checks every **tracked** keyword in every country, adds today's ranks to `.searchd/history/`, and reports what moved since the last earlier day. Example output:

```
Since 2026-10-24: 2 up, 1 down.
🇺🇸 daily planner: #3 → #1 (▲2)
🇩🇪 tagesplaner: 200+ → #48 (▲153)
🇯🇵 スケジュール帳: #12 → #15 (▼3)

Top 3 in 5 of 40 checks: 🥇 3 · 🥈 2
  e.g. 🥇 🇺🇸 daily planner · 🥈 🇬🇧 daily planner · …
```

Run it once a day. Ranks wobble on their own, so judge a listing change over 1–2 weeks. Running it twice in one day is free (cached).

### `/searchd-audit`

Suggests a rewritten listing **for each App Store language** your countries use (en-US, en-GB, de-DE, fr-FR, ja, es-ES, pt-BR…):

- **Name (≤ 30):** your brand, then the single most valuable phrase.
- **Subtitle (≤ 30):** the next most valuable phrases, still readable for people.
- **Keyword field (≤ 100):** single words, comma-separated, no spaces. Apple combines words across all three fields, so `food,diary` also matches "food diary".

Words are picked from your data: high opportunity first, then words from keywords where you rank #11–50 (close to page one); words with no demand are dropped. Before you see anything, `audit.js` checks every listing and prints exact counts:

```
de-DE (DE)
  name      ✓  26/30  Cronometer: Kalorienzähler
  subtitle  ✓  25/30  Makro Tracker & Ernährung
  keywords  ✓  58/100  ernährungstagebuch,vitamine,intervallfasten,protein
```

It rejects: going over a limit, spaces in the keyword field, empty items (`a,,b`), a word listed twice, and a word that's already in the name or subtitle (a wasted character: Apple already indexes it). Characters are counted the way Apple shows them, so "ä" or an emoji counts as one.

searchd **never touches App Store Connect**. You copy the text in yourself; name and keyword changes go live with your next app version.

### `/searchd-dashboard`

Builds `.searchd/dashboard.html` and opens it in your browser. See [The dashboard](#the-dashboard).

## The dashboard

A single HTML file with your data baked in: it opens straight from your disk with no server, and works offline except for app icons, which load from Apple's servers. It follows your system's dark or light mode (the Theme button switches it), and works on a phone. Re-run `/searchd-dashboard` after new checks to refresh it.

| Tab | What it shows |
|---|---|
| **Board** | Every keyword × country rank in one grid: 🥇🥈🥉, then colored pills for top 10, top 50, and top 200; ▲▼ change since the previous check. Hover a rank to see the local phrase. Filter: Tracked / Ideas / All. |
| **Keywords** | One country at a time: local phrase (with the English keyword under it), rank, volume and difficulty bars, opportunity, and the top 5 apps' icons (yours is outlined). |
| **Competitors** | **Losing to:** the apps that rank above you in the most checks (every top-10 app above you counts as one), with their ratings and average position. **Head to head:** your rank vs. each competitor from setup, per keyword. |
| **Ideas** | Brainstormed keywords, best opportunity first; ⭐ sweet spots are highlighted. |
| **History** | One small rank-over-time chart per tracked keyword. The scale is logarithmic with #1 at the top, so moving #40 → #20 looks as big as #4 → #2. Gaps mean "not in the top 200". |

It stays small and fast. In a stress test with 120 keywords × 10 countries (1,200 checks) and 90 days of history, the file was 675 KB, it loaded in about 0.3 seconds, and every tab switched in under 30 ms.

## How the scores work

Apple doesn't publish search volumes or difficulty. searchd estimates them from what a search returns: one search per keyword per country gives all the numbers below. The math is in [`lib/score.js`](skills/searchd-find/scripts/lib/score.js), commented line by line.

### Rank

Your app's position in Apple's search results: 1 = first. The API returns up to 200 apps, so if you're not in them you're shown as **200+**. In history and movement, 200+ counts as 201, so dropping out of the results is a drop.

### Volume (0–100): a demand proxy, not a search count

If most of the top 50 apps put a phrase in their name, many developers decided it's worth ranking for, which usually means people search for it. Each of the top 50 apps counts:

| The app… | Counts |
|---|---|
| has the exact phrase in its name ("Calorie Counter by fatsecret") | 1.0 |
| has every word in its name, in any order, or the same letters spaced differently ("Kalorien Zähler" for "kalorienzähler") | 0.6 |
| only mentions all the words in its description | 0.25 |

**Volume = total ÷ 50 × 100.** We always divide by 50, so a search with only 12 results can't score high: few apps at all is itself a sign of a niche search.

Text is compared after cleaning: lowercase, Unicode-normalized (full-width "Ａ" = "A"), punctuation and symbols removed ("Lose It! – Calorie Counter™" = "lose it calorie counter"). Words must match whole ("cal" doesn't match "calorie"), except in Japanese, Chinese, Korean, and Thai, which don't put spaces between words.

### Difficulty (0–100)

Rating counts are the best public sign of how big an app is. Each top-10 app gets a size score on a **log scale**:

| Ratings | ~10 | ~100 | ~1,000 | ~10,000 | ~100,000 | ~1,000,000 |
|---|---|---|---|---|---|---|
| Size score | 17 | 33 | 50 | 67 | 83 | 100 |

Difficulty is the average of the ten. Empty slots count as 0, because a search with only 3 apps is easy to break into.

Why the log scale, and why average the *scores* rather than the rating counts? We tested both on real searches. With a raw average, one giant decides everything: MyFitnessPal's 2.3 million ratings made "food diary" look 92/100 hard, even though three of its top 10 apps had under 10 ratings. Averaging the log scores gives 54: a typical top-10 app is beatable, which is the honest answer.

### Opportunity and ⭐ sweet spots

**Opportunity = volume × (100 − difficulty) ÷ 100**: demand you can realistically win. Volume 60 with difficulty 25 scores 45; volume 60 with difficulty 90 scores 6.

A ⭐ **sweet spot** has volume ≥ 20 and difficulty ≤ 55: real demand and beatable competition. These thresholds were tuned on real searches (calorie trackers, focus apps, planners); adjust `SWEET_SPOT` in `score.js` if your category runs hotter or cooler.

### Localization

People in Germany don't search "calorie counter"; they search "kalorienzähler". Your agent writes the phrase a native speaker would type in each country, and searchd stores both: the English keyword groups the results, the local phrase is what's searched. There's no translation API, so a translation is only as good as your agent. If a phrase looks wrong, tell your agent and it updates just that country.

## Speed, rate limits, and reliability

**How long a run takes.** Apple allows roughly 20 searches a minute, so searchd waits about 3.5 seconds between searches. That's the only thing that sets the speed: everything else takes a few milliseconds per check.

| Keywords × countries | Checks | First run | Again the same day |
|---|---|---|---|
| 5 × 2 | 10 | ~35 s | instant |
| 11 × 10 | 110 | ~7–8 min (measured: 8 min 7 s) | instant (measured: 1 s) |
| 20 × 10 | 200 | ~12–14 min | instant |

`/searchd-audit` adds one lookup per country (about 30 seconds for 10 countries).

The first line of every run gives the estimate. Your agent runs anything over ~8 minutes in the background.

**What happens when things go wrong:**

| Situation | What searchd does |
|---|---|
| Apple says "slow down" (HTTP 403/429) | waits 10 s, 30 s, then 60 s before retrying, and makes the throttle 1.5× slower (up to 10 s); after 20 searches in a row go through, it speeds back up. The end of the run says how often this happened |
| Apple has a hiccup (HTTP 5xx) | retries the same way |
| You're offline | retries once, and after 3 failed searches in a row stops the run with a clear message, instead of grinding through every check |
| You stop a run (Ctrl+C, closed laptop) | everything finished so far is saved; files are written atomically, so they're never half-written |
| You run it again | finished searches come from today's cache, so it continues where it left off |
| Two runs start in the same folder | the second is refused ("another check is already running"), so neither loses results; a lock left by a crashed run is detected and taken over |
| A saved file is damaged | a damaged cache file is fetched again; any other damaged file is named in a clear error |

## Your data

Everything is in `.searchd/` inside the folder you run searchd from, as plain JSON you can open:

| File | What's in it |
|---|---|
| `app.json` | your app (ID, name, icon, description), countries, competitors |
| `keywords.json` | every keyword: `keyword`, `status` (tracked / idea), `local` (phrase per country) |
| `results.json` | the latest check per keyword × country: phrase, rank, volume, difficulty, opportunity, top 10 apps, competitors' ranks |
| `history/<date>.json` | that day's ranks: `{ "keyword\|cc": rank }` (null = 200+) |
| `cache/<date>/` | today's raw search results (older days are deleted automatically) |
| `audit.json` | the last listing suggestion that passed the checks |
| `dashboard.html` | the generated dashboard |
| `archive/` | data from an app you switched away from |

`/searchd-setup` adds `.searchd/` to your project's `.gitignore` if it has one. Delete the folder to start over.

## Running the scripts yourself

The skills are plain Node.js scripts, so you can run them without an agent. Run them from your project folder (`SKILLS` = where you installed searchd, e.g. `~/.claude/skills`):

```bash
node $SKILLS/searchd-setup/scripts/setup.js resolve "structured daily planner"
echo '{"appId":1499198946,"countries":["us","de"],"seeds":["daily planner"]}' | node $SKILLS/searchd-setup/scripts/setup.js save

node $SKILLS/searchd-find/scripts/find.js status            # app, countries, keywords missing a local phrase
echo '[{"keyword":"daily planner","local":{"us":"daily planner","de":"tagesplaner"}}]' | node $SKILLS/searchd-find/scripts/find.js keywords
node $SKILLS/searchd-find/scripts/find.js check             # options: --status tracked|idea|all  --keywords "a,b"  --countries "us,de"
node $SKILLS/searchd-find/scripts/find.js summary           # options: --status …  --limit 50

node $SKILLS/searchd-track/scripts/track.js                 # option: --countries "us,de"
node $SKILLS/searchd-audit/scripts/audit.js data
node $SKILLS/searchd-audit/scripts/audit.js check < listing.json
node $SKILLS/searchd-dashboard/scripts/dashboard.js         # option: --no-open
```

In `find.js keywords`, `"status": "tracked"` tracks a keyword and `"remove": true` deletes one. Every script validates its input and lists all problems at once; nothing is saved until the input is valid.

## Troubleshooting

| Message | What to do |
|---|---|
| `searchd isn't set up in this folder` | Run `/searchd-setup` in your app's project folder (searchd's data is per folder). |
| `Stopped: the last 3 searches failed` | You're offline or Apple is rate-limiting your network. Wait a few minutes and run again; finished checks are kept. |
| `Another searchd check is already running` | A run (maybe in the background) hasn't finished. Wait for it. |
| `Skipped (no local phrase yet …)` | Some keywords aren't translated for some countries. `/searchd-find` fills them in. |
| `app … isn't on the XX App Store` | Your app isn't sold in the first country you listed. Put a country where it's sold first. |
| `searchd: install all five skills together` | One skill folder is missing; reinstall with `npx skills add https://github.com/notsocj/searchd --skill`. |
| Everything says 200+ | Check the app ID in `.searchd/app.json`, and that the app is sold in those countries. |

## Limitations

- **Volume is a proxy, not real search data.** It measures how much developers *target* a phrase, which tracks demand but isn't a count of searches. Use it to compare keywords, not to forecast downloads.
- **The API's order can differ slightly from the App Store app.** The iTunes Search API is close to, but not exactly, what people see on their phones (which also personalizes results). Treat ranks as a good approximation and watch the trend.
- **Only the top 200.** Below that, every app is "200+".
- **Word matching is simple.** Plurals ("calorie" vs "calories") count as different words, and symbols are dropped ("c++" is read as "c").
- **Difficulty only sees ratings**, not app age, update frequency, or conversion rate.
- **Translations are your agent's.** No translation API checks them.
- **iPhone apps only** for now (`entity=software`).

## Privacy and safety

- searchd only talks to `itunes.apple.com`, Apple's public search API. No key, no account, no telemetry. The dashboard loads app icons from Apple's image servers and nothing else.
- It never signs in to App Store Connect and never changes or submits your listing. `/searchd-audit` only suggests text.
- App names and descriptions from the App Store are treated as untrusted data: your agent is told never to follow instructions inside them, and the dashboard inserts them as plain text under a strict Content-Security-Policy, so an app name can't inject HTML or scripts.
- Zero npm dependencies: only Node.js built-ins, so you can read every line.

## Coming later

Not in v1, but the design leaves room for:

- **App Store Connect:** with an API key (stored securely, never shown to the agent), read your real keyword field and create a **draft** version with the new listing. It will never submit for review.
- **Google Play** support.

## Development

```bash
npm test              # node:test, no dependencies; tests never touch the network
./install.sh --link   # symlink the skills, so edits in this repo apply immediately
```

- Contributor notes and conventions: [`CLAUDE.md`](CLAUDE.md).
- Shared code: `skills/searchd-find/scripts/lib/` (`store.js` files and locking, `itunes.js` API client, `score.js` scoring, `checks.js` the check runner). The other skills load it through their `shared.js`.
- Set `SEARCHD_DIR` to use a different data folder (the tests do this).
- **Never run `npx skills add` or `npx skills remove` without `-g` inside this repo.** The installer treats the repo's `skills/` folder as an install location, so a project-scope remove deletes the source. If that happens, `git restore skills/`.

## Credits

- Dashboard font: [Poppins](https://github.com/itfoundry/Poppins) by Indian Type Foundry ([SIL Open Font License 1.1](skills/searchd-dashboard/scripts/fonts/OFL.txt)), embedded so the page loads no fonts from the internet.
- Data: Apple's public [iTunes Search API](https://performance-partners.apple.com/search-api). searchd isn't affiliated with or endorsed by Apple.

## License

[MIT](LICENSE)
