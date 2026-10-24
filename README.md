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

---

## Why ASO matters

Most App Store downloads start with a search. Apple decides which apps show up mainly from three fields you control: the **app name**, the **subtitle**, and a hidden 100-character **keyword field**. Picking the right words for those fields, the ones people actually type and that you can realistically rank for, is App Store Optimization (ASO). It's free, and for a small app it's often the biggest lever there is.

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

### The dashboard

`/searchd-dashboard` writes a single HTML file with your data baked in, so it opens straight from your disk with no server. It works in dark and light mode and on a phone. Tabs:

- **Board:** every keyword × country rank in one grid, with ▲▼ changes since the previous check
- **Keywords:** per country, with volume and difficulty bars and the top 5 apps' icons (yours is outlined)
- **Competitors:** the apps you're losing to most, plus a head-to-head with the competitors you picked
- **Ideas:** brainstormed keywords, best opportunity first, with ⭐ sweet spots
- **History:** a rank-over-time chart per keyword

## Requirements

- [Node.js](https://nodejs.org) **18 or newer**
- Claude Code or Codex

## Install

**Recommended:** with the open [`skills`](https://skills.sh) installer (works for Claude Code, Codex, and other agents):

```bash
npx skills add https://github.com/notsocj/searchd --skill '*' -g
```

Choose **Symlink (Recommended)** when it asks.

- **`--skill '*'` matters.** searchd is five skills that share code, so install all five together. If one is missing, searchd tells you the command to fix it.
- **Keep `-g`** so searchd works in every project, not just the folder you ran the installer in.
- **Update:** `npx skills update -g`. **Remove:** `npx skills remove -g searchd-setup searchd-find searchd-track searchd-audit searchd-dashboard`.

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

## Commands

| Command | What it does |
|---|---|
| `/searchd-setup [app]` | Finds your app (link, name, or numeric ID), saves the countries to track (default: US, GB, CA, AU, PH, DE, FR, JP, ES, BR), seed keywords, and optional competitors. Run it again to change them; your results are kept |
| `/searchd-find [topic]` | Brainstorms 15–25 keyword ideas from your app's description, localizes every keyword per country, checks rank / volume / difficulty / top apps, and summarizes the best opportunities. Asks which ideas to track |
| `/searchd-track` | Re-checks every tracked keyword in every country, saves today's ranks, and reports what moved since the last check |
| `/searchd-audit` | Suggests a new name (30), subtitle (30), and keyword field (100) per language, checked against Apple's rules, with character counts. Never touches App Store Connect |
| `/searchd-dashboard` | Builds `.searchd/dashboard.html` and opens it |

## How the scores work

Apple doesn't publish search volumes or difficulty. searchd estimates them from what a search returns: one search per keyword per country gives all the numbers below. The math is in [`lib/score.js`](skills/searchd-find/scripts/lib/score.js), commented line by line.

### Rank

Your app's position in Apple's search results: 1 = first. The API returns up to 200 apps, so if you're not in them you're shown as **200+**.

### Volume (0–100): a demand proxy, not a search count

If most of the top 50 apps put a phrase in their name, many developers decided it's worth ranking for, which usually means people search for it. Each of the top 50 apps counts:

| The app… | Counts |
|---|---|
| has the exact phrase in its name ("Calorie Counter by fatsecret") | 1.0 |
| has every word in its name, in any order, or the same letters spaced differently ("Kalorien Zähler" for "kalorienzähler") | 0.6 |
| only mentions all the words in its description | 0.25 |

**Volume = total ÷ 50 × 100.** We always divide by 50, so a search with only 12 results can't score high: few apps at all is itself a sign of a niche search.

### Difficulty (0–100)

Rating counts are the best public sign of how big an app is. Each top-10 app gets a size score on a **log scale** (~10 ratings → 17, ~1,000 → 50, ~100,000 → 83, ~1,000,000 → 100), and difficulty is the average of the ten. Empty slots count as 0, because a search with 3 apps is easy to break into.

Why the log scale and why average the *scores* rather than the rating counts? We tested both on real searches. With a raw average, one giant decides everything: MyFitnessPal's 2.3 million ratings made "food diary" look 92/100 hard, even though three of its top 10 apps had under 10 ratings. Averaging the log scores gives 54: a typical top-10 app is beatable, which is the honest answer.

### Opportunity and ⭐ sweet spots

**Opportunity = volume × (100 − difficulty) ÷ 100**: demand you can realistically win. A ⭐ **sweet spot** has volume ≥ 20 and difficulty ≤ 55.

### Localization

People in Germany don't search "calorie counter"; they search "kalorienzähler". Your agent writes the phrase a native speaker would type in each country (not a word-for-word translation), and searchd stores both: the original keyword groups the results, the local phrase is what's searched. There's no translation API.

### Rate limits and the cache

Apple allows roughly 20 searches a minute, so searchd waits about 3.5 seconds between calls and retries with growing pauses (10 s, 30 s, 60 s) when Apple says to slow down. 20 keywords × 10 countries = 200 searches ≈ 12 minutes. Every search is cached for the day (`.searchd/cache/`), so re-running, or stopping and resuming, never repeats one.

## Limitations

- **Volume is a proxy, not real search data.** It measures how much developers *target* a phrase, which tracks demand but isn't a count of searches. Use it to compare keywords, not to forecast downloads.
- **The API's order can differ slightly from the App Store app.** The iTunes Search API is close to, but not exactly, what people see on their phones (which also personalizes results). Treat ranks as a good approximation and watch the trend.
- **Only the top 200.** Below that, every app is "200+".
- **Word matching is simple.** Plurals ("calorie" vs "calories") count as different words, and Japanese, Chinese, Korean, and Thai use substring matching because they don't put spaces between words.
- **Difficulty only sees ratings**, not app age, update frequency, or conversion rate.
- **iPhone apps only** for now (`entity=software`).

## Your data

Everything is in `.searchd/` inside the folder you run searchd from, as plain JSON you can open:

| File | What's in it |
|---|---|
| `app.json` | your app, countries, competitors |
| `keywords.json` | every keyword, tracked or idea, with its local phrase per country |
| `results.json` | the latest check per keyword × country: rank, scores, top 10 apps |
| `history/<date>.json` | that day's ranks |
| `cache/<date>/` | today's raw search results (older days are deleted automatically) |
| `audit.json` | the last listing suggestion |
| `dashboard.html` | the generated dashboard |

`/searchd-setup` adds `.searchd/` to your project's `.gitignore` if it has one. searchd only talks to `itunes.apple.com`. The dashboard loads app icons from Apple's image servers and nothing else.

## Coming later

Not in v1, but the design leaves room for:

- **App Store Connect:** with an API key (stored securely, never shown to the agent), read your real keyword field and create a **draft** version with the new listing. It will never submit for review.
- **Google Play** support.

## Development

```bash
npm test              # node:test, no dependencies; tests never touch the network
./install.sh --link   # symlink the skills, so edits in this repo apply immediately
```

Contributor notes and conventions: [`CLAUDE.md`](CLAUDE.md). Set `SEARCHD_DIR` to use a different data folder (the tests do this).

## Credits

- Dashboard font: [Poppins](https://github.com/itfoundry/Poppins) by Indian Type Foundry ([SIL Open Font License 1.1](skills/searchd-dashboard/scripts/fonts/OFL.txt)), embedded so the page loads no fonts from the internet.
- Data: Apple's public [iTunes Search API](https://performance-partners.apple.com/search-api). searchd isn't affiliated with or endorsed by Apple.

## License

[MIT](LICENSE)
