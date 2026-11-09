# Hnátová Beach Draw - handoff for Claude Code

You are continuing a project started in a Claude Cowork session. Everything you need is in this file and in this repository. Talk to the owner (Ondra) in Czech, never use em dashes (use a plain hyphen "-").

## 1. What exists today

- Public static site (GitHub Pages): https://ondrahnat.github.io/beach/ served from this repo (`main`, root).
  - `index.html` - the whole app (engine + UI, Czech with CZ/EN switch). Do not rewrite it; extend it.
  - `data.json` - all data the page renders (schema in section 5).
  - `photo-heli.jpg`, `photo-maky.jpg` - profile photos.
- A private Claude artifact (https://claude.ai/artifact/BroEFXWcTXYNxhiq57D9ve) with the same page. Until now a Claude scheduled task updated ITS data.json when Ondra pressed "Obnovit" there. That copy cannot write to GitHub, so the public site goes stale. This handoff replaces that flow with one that lives entirely on GitHub + Cloudflare.
- The app is for Ondra's daughters Helena Hnátová (Heli) and Markéta Hnátová (Maky), club BVŠP, Prague youth beach volleyball: Pražská beachliga (volejbalpraha.cz), Letní pražská beachliga, ABV/ČVS national tournaments (cvf.cz, results in public Google Sheets).

## 2. Goal

Anyone who has the public link can press **Obnovit** (and paste a tournament link to add it) on the website itself. That starts an update that refreshes data.json in this repo; the site redeploys and every viewer sees the new data. No Claude app, no Ondra computer needed.

## 3. Target architecture

1. **Hosting: Cloudflare Pages** connected to this GitHub repo (auto deploy on every push to `main`), project name `hnatova-beach` -> https://hnatova-beach.pages.dev. Keep GitHub Pages working too (same files), it costs nothing.
2. **Pages Functions** in `functions/api/`:
   - `POST /api/refresh` body `{pin, url?}`:
     - check `pin` against env `FAMILY_PIN` (Ondra decides whether a PIN is used; if env `FAMILY_PIN` is empty, skip the check);
     - guard costs: refuse if a `refresh.yml` run is queued/in progress, if the last run started < 10 min ago, or if >= env `MAX_RUNS_PER_DAY` (default 12) runs started today (Europe/Prague); use the GitHub REST API with env `GITHUB_TOKEN`;
     - validate optional `url` (only `https://(www.|old.)?volejbalpraha.cz/...` or `https://(www.|old.)?cvf.cz/...`);
     - dispatch `.github/workflows/refresh.yml` (`workflow_dispatch`, inputs `{url}`), return `{ok, message}` in Czech.
   - `GET /api/status` -> latest `refresh.yml` run `{status, conclusion, created_at, updated_at, html_url}` (proxy so the browser needs no token and no GitHub rate limit).
   - Env vars (Cloudflare dashboard, encrypted): `GITHUB_TOKEN` = fine-grained PAT for `ondrahnat/beach` only, permissions Actions: read & write, Contents: read, Metadata: read; `FAMILY_PIN`; `MAX_RUNS_PER_DAY`.
3. **GitHub Actions workflow** `.github/workflows/refresh.yml`:
   - triggers: `workflow_dispatch` (input `url`, optional); optionally a schedule later (ask Ondra; e.g. every 2 h on Sat/Sun 8-20 Prague time).
   - `concurrency: refresh` (no parallel runs), `permissions: contents: write`, timeout 30 min.
   - steps: checkout; run Claude Code headless (`npx -y @anthropic-ai/claude-code -p "<prompt>"` or `anthropics/claude-code-action`) with secret `ANTHROPIC_API_KEY`, prompt = `.github/refresh-prompt.md` (+ the `url` input appended when present), model: a Sonnet model to keep cost low, allowed tools: Bash, Read, Write, Edit, WebFetch; then `python3 scripts/validate.py data.json` (must pass, otherwise fail the run without committing); commit `data.json` only if changed, message `data: refresh <ISO time>`, push to `main`.
   - The runner has normal internet: fetch volejbalpraha.cz pages with curl and parse the HTML (more reliable than WebFetch summaries). Public ČVS Google Sheets can be read as CSV: `https://docs.google.com/spreadsheets/d/<id>/gviz/tq?tqx=out:csv&sheet=<sheet name>`.
4. **index.html changes** (keep everything else as is):
   - On the public site (`!window.claude`) the header button **↻ Obnovit** (`#ownerLink`, currently a link to the Claude artifact) becomes a real button: asks for the PIN once (remember it in localStorage, try/catch), POSTs `/api/refresh`, then polls `/api/status` every 15 s, shows "Načítá se…" and disables the button while queued/in_progress, and when the run completes successfully reloads `data.json?ts=<now>` and re-renders. Show errors in Czech.
   - Show the "Přidat turnaj" box (link input) on the public site as well, wired to the same `/api/refresh` with `url`. Keep the existing Claude-artifact admin code path working when `window.claude` exists.
   - Fetch `data.json` with a cache-busting query.
   - Relative URLs only, so the page works on both github.io/beach/ and pages.dev.
5. `scripts/validate.py`: JSON parses; ids unique; every match `a`/`b` exists in its league's teams; every league of a not-finished tournament contains Helena or Markéta; `profiles` kept; tournaments count did not drop by more than 1 vs the previous commit (guards against a broken run wiping data).

## 4. What Ondra must do by hand (guide him step by step, in Czech)

1. Anthropic API key: console.anthropic.com -> account, billing (card), set a monthly spend limit, create key -> GitHub repo Settings -> Secrets and variables -> Actions -> `ANTHROPIC_API_KEY`.
2. GitHub fine-grained PAT (Settings -> Developer settings -> Fine-grained tokens) for repo `ondrahnat/beach` with the permissions above.
3. Cloudflare account -> Workers & Pages -> Create -> Pages -> Connect to Git -> `ondrahnat/beach`, project name `hnatova-beach`, no build command, output dir `/`; add env vars `GITHUB_TOKEN`, `FAMILY_PIN`, `MAX_RUNS_PER_DAY`.
4. Decide: PIN yes/no, and whether to add a schedule.
Then run one test refresh from the website and check the Actions log and the result.

## 5. data.json schema (the page engine depends on it - keep it exactly)

```
{"updatedAt": ISO with Prague offset,
 "players": ["Helena Hnátová","Markéta Hnátová"],
 "profiles": {"asOf":"YYYY-MM-DD","players":[{"name","club","photo","pvsUrl","cvfUrl",
     "pvs":[{"cat","season","rank","of","points","url"}],
     "abv":[{"cat","code","rank","points","url"}]}]},
 "tournaments": [
  {"id": "pvs-<detail id>" | "cvf-<id>", "source": "pvs"|"cvf", "series": "pbl"|"leto"|"abv",
   "url", "sheet"?, "name" (pvs e.g. "Pražská beachliga U16Ž" / "Letní beachliga U16Ž"), "round",
   "category" (e.g. "U16Ž"), "date": "YYYY-MM-DD", "start": "HH:MM",
   "venue" (short name, part before the first comma for pvs), "status": "upcoming"|"live"|"finished",
   "system": "pvs"|"cvf", "model"?, "teamsTotal",
   "leagues": [
     PVS: {"name":"Liga 1","teams":[{"seed","key","p1","p2","club","index","points"}],"seedNote"?,
           "official": null | {"groups":[{"name","teams":[keys],"matches":[{"round","no","court","a","b","sets","points"}]}],
                               "playoff":[{"stage","round","no","court","a","b","sets","points"}]}}
     ČVS: {"name":"Hlavní soutěž"|"Kvalifikace","system":"cvf-h16-skupmod"|"cvf-h24-2ko"|"cvf-q18"|"cvf",
           "teams":[{"seed","key","p1","p2","club","index","note"?}],
           "official": null | {"matches":[{"tid":"M<n>","no","round","date","time","court","a","b","sets","points"}]}} ]}]}
```
key = last word of p1 + "/" + last word of p2 (e.g. "Hnátová/Němcová"); every a/b uses keys. sets like "1:0" / "2:1" (keep "X" walkovers as written, e.g. "X:2"); points like "21:17" or "21:19, 18:21, 13:15". status: any date before today = "finished"; "live" only on the event day; future = "upcoming". A tournament where neither girl is registered keeps `"leagues": []`.

## 6. Update rules (put these into `.github/refresh-prompt.md`, adapted to "edit data.json in the working directory")

Never invent data; if not in the source leave null/empty. Keep only leagues/stages that contain Helena Hnátová or Markéta Hnátová. Budget about 12 tournaments per run.

**Refresh window = today-14 .. today+14 (Europe/Prague):**
a) Upcoming discovery (today..today+14):
   - Pražská beachliga: https://www.volejbalpraha.cz/beach/ lists upcoming tournaments by start date (20 per page; page 2 = `?grid-page=2&grid-sort%5BstartDate%5D=asc&grid-sort%5Bname%5D=asc&do=grid-page`). Candidates: girls'/mixed categories (U10, U12Z/U12Ž, U12 MIX, U14Ž, U14 MIX, U16Ž, U18Ž, U20Ž, Letní beachliga) in the window, not yet in data.json. Open each detail page `https://www.volejbalpraha.cz/beach/detail/<id>` and check all league pair lists for "Hnátová"; add hits.
   - ČVS: ONLY national ABV tournaments ("ABV celostátní"): https://www.cvf.cz/beachvolejbal/turnaje (pagination `?tournamentLister-vp-page=N`). Candidates in the window with "Složka" = "národní" AND title marked "(celostátní)" (e.g. "Český pohár U16 (celostátní)") or MČR / Mistrovství ČR, categories U14-U20 ženy/dívky. Check the registered pairs on the detail page `https://www.cvf.cz/beachvolejbal/turnaje?tournamentId=N` for "Hnátová"; add hits.
b) Every tournament in data.json dated today..today+14: reload everything. For not-finished tournaments rebuild "leagues" FROM SCRATCH every time: while more pairs register, the PVS site re-orders pairs and re-allocates leagues (1. liga, 2. liga ...), so a girl may drop to a lower league before the start. Keep ONLY the league(s)/stage(s) she is in now and delete the old one. Current pair list order = seeding; current official groups/playoff (null if not drawn); update teamsTotal. If neither girl is registered any more -> "leagues": [].
c) Every tournament dated today-14..today-1: re-read the girls' leagues/stages: all results, final/placement matches and "points"; correct differences.
d) If a `url` input is given: add or reload that tournament first.
e) Rankings (update "profiles", keep photo/pvsUrl/cvfUrl): PVS current winter season `https://www.volejbalpraha.cz/beach/result/{id}?type=A` with U12Z 15, U14Ž 4, U16Ž 6, U18Ž 8, U20Ž 10 (rank #, Body, number ranked = "of"; only categories where the girl appears). ABV: `https://www.cvf.cz/beachvolejbal/zebricek?rankingItemLister-vp-page=1&rankingItemLister-filter%5BfolderId%5D=2&rankingItemLister-filter%5BrankingId%5D={code}&rankingItemLister-filter%5Bname%5D=Hn%C3%A1tov%C3%A1` for ZKY (U16 ženy), KKY (U18), JKY (U20), Z (ženy); rank + points; url = that URL. Set asOf = today. (The page hides Helena's U16 ABV ranking itself.)

**PVS detail page (volejbalpraha.cz/beach/detail/<id>):** header (name, round, category, date+time, venue, total teams); per league: pair list in shown order (position, index, both full names, clubs, "Počet bodů" = league points after the event -> team "points", null if not shown); groups (teams in listed order; every match: round, number, court, a, b, sets, points); playoff/placement matches with the Czech stage label exactly as written (e.g. "Osmifinále - o 1. až 12. místo", "Finálový zápas - o 5. místo"), round, number, court, a, b, sets, points.
Seeds after the event: the site re-sorts the pair list by result, so for a finished tournament not yet in data.json rebuild seeds from the groups (teams inside a group are listed in seed order): 4 groups -> A[1,8,9,16] B[2,7,10,15] C[3,6,11,14] D[4,5,12,13]; 2 groups -> A[1,4,5,8] B[2,3,6,7]; 5-team groups continue A17 B18 C19 D20; renumber 1..n in slot order and set league "seedNote": "reconstructed". For a finished tournament already in data.json keep its seeds/teams, refresh points and results. series = "leto" if the name contains "Letní", else "pbl".

**ČVS tournament (cvf.cz / old.cvf.cz):** detail page -> name, date, place, category, "Online rozpis a výsledky" Google Sheet link, propozice. If the sheet is not published yet, take the registered pairs from the page. Sheet tabs: "info", "HS - startovní listina", "HS - utkání", optionally "Q - startovní listina", "Q - utkání". One league per stage ("Kvalifikace" = Q, "Hlavní soutěž" = HS), keep a stage only if a girl is in it now. teams from startovní listina in order: seed = Č., p1/p2 as "First Last" (sheets use either order), club "", index = Body / Vstupní body (number), note = Pozn. (Q, LL, DKP, WC). matches: {"tid":"M"+Č., "no", "round": Kolo, "date", "time", "court": Hř., "a","b", "sets":"2:1", "points"}. Each set is one number from team 1's view: v>0 team 1 won and the opponent scored v; v<0 team 1 lost and scored |v|; winner score = max(T, |v|+2), T = 21 sets 1-2, 15 set 3 (or per info sheet). Example "-17, 10, 10" -> "17:21, 21:10, 15:10". system: "cvf-h16-skupmod" (HS 16 teams, kolo A-I, A-II, A-W, A-L ... 9, 5, SF, F3, F1; 28 matches), "cvf-h24-2ko" (HS 24 teams, kolo I, II, 17, III, 13, 9, IV, 7, 5, SF, F3, F1; 46 matches), "cvf-q18" (Q 18 teams, A-I..F-III + 6 matches of kolo "I"; 24 matches), else "cvf". Set "model" from the propozice if stated, "sheet" = sheet URL, series "abv". No sheet -> teams only, "official": null.

## 7. Known open items
- pvs-1975 (U14Ž 7. 11. 2026): league points not published yet on the site; the refresh will fill them.
- pvs-1816 (Letní U14Ž 20. 6. 2026): placement left empty on purpose (ambiguous pair on the site); do not guess.
