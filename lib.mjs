// Hnátová Beach Draw - scraping and data rules (no AI, runs in GitHub Actions).
// Pure functions: every parser takes HTML/CSV text and a `parseHTML(html) -> Document` function,
// so the same code runs in Node (linkedom) and in a browser (DOMParser) for testing.

export const PLAYERS = ['Helena Hnátová', 'Markéta Hnátová'];
export const PVS = 'https://www.volejbalpraha.cz';
export const CVF = 'https://www.cvf.cz';

/* ---------------- small helpers ---------------- */
export const txt = el => (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
const nfc = s => String(s || '').normalize('NFC');
const fold = s => nfc(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const lastWord = n => nfc(n).trim().split(/\s+/).pop();
export const keyOf = (p1, p2) => `${lastWord(p1)}/${lastWord(p2)}`;
export const isGirl = name => PLAYERS.some(p => fold(p) === fold(name));
export const girlName = name => PLAYERS.find(p => fold(p) === fold(name)) || null;
export const hasGirl = text => /hn[aá]tov[aá]/i.test(nfc(text));
const num = s => { if (s == null) return null; const t = String(s).replace(/\s/g, '').replace(',', '.'); if (t === '' || t === '-') return null; const v = Number(t); return Number.isFinite(v) ? v : null; };
const int = s => { const v = parseInt(String(s || '').trim(), 10); return Number.isFinite(v) ? v : null; };
const hhmm = s => { const m = String(s || '').match(/(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, '0') + ':' + m[2] : null; };
export function pragueToday(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(d); }
export function addDays(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function pragueIso(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'longOffset' }).formatToParts(d).map(p => [p.type, p.value]));
  const off = (parts.timeZoneName || 'GMT+01:00').replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}${off}`;
}
export const statusFor = (date, today) => date < today ? 'finished' : date === today ? 'live' : 'upcoming';
function catNorm(c) { // "U12Z" -> "U12Ž", "U16 ženy" -> "U16Ž"
  c = nfc(c).trim();
  let m = c.match(/^(U\d{2})\s*(ženy|dívky|Ž|Z)$/i); if (m) return m[1].toUpperCase() + 'Ž';
  return c;
}
export function seasonOf(date) { const y = +date.slice(0, 4), m = +date.slice(5, 7); const s = m >= 8 ? y : y - 1; return `${s}/${String(s + 1).slice(2)}`; }

/* =============== Pražská beachliga (volejbalpraha.cz) =============== */

// Pair cell "Helena Hnátová (BVŠP)" -> {name, club}
function splitPlayer(s) { s = txt({ textContent: s }); const i = s.indexOf(' ('); if (i < 0) return { name: s, club: '' }; return { name: s.slice(0, i).trim(), club: s.slice(i + 2).replace(/\)\s*$/, '').trim() }; }
function parseResult(s) {
  s = String(s || '').trim(); if (!s) return { sets: null, points: null };
  const m = s.match(/^([\dX]+\s*:\s*[\dX]+)/i); const p = s.match(/\(([^)]*)\)/);
  return { sets: m ? m[1].replace(/\s/g, '') : null, points: p ? p[1].trim().replace(/\b0+(\d)/g, '$1') : null };
}

// Seeds rebuilt from the groups (teams inside a group are listed in seed order). Snake over groups.
export function seedsFromGroups(groups) {
  const G = groups.length; const slot = {};
  groups.forEach((g, gi) => g.teams.forEach((k, r) => { slot[k] = r * G + (r % 2 === 0 ? gi : G - 1 - gi) + 1; }));
  return slot;
}

export function parsePvsDetail(html, id, parseHTML) {
  const d = parseHTML(html);
  const panel = d.querySelector('.tournament-detail') || d.body;
  const p = txt(panel);
  const h1 = txt(d.querySelector('.tournament-detail h1') || d.querySelector('h1'));
  const dm = p.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}:\d{2})/);
  const date = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : null;
  const start = dm ? hhmm(dm[4]) : null;
  const kolo = (p.match(/(\d+)\.\s*kolo/i) || [])[1];
  const venue = ((p.match(/Místo:\s*([^,]+)/) || [])[1] || '').trim() || null;
  let category = ((p.match(/Kategorie:\s*(\S+)/) || [])[1] || '').trim();
  if (!category || /:$/.test(category)) category = (h1.match(/(U\d{2}\S*)/) || [])[1] || h1;
  category = catNorm(category);
  const letni = /Letní/i.test(p.slice(0, 200)) || /Letní/i.test(txt(d.querySelector('title')));
  const total = int((txt(d.body).match(/Celkem zaregistrováno týmů:\s*(\d+)/) || [])[1]);

  // pair lists: <h2>Liga N</h2> followed by a table
  const lists = {};
  for (const h2 of d.querySelectorAll('h2')) {
    const lm = txt(h2).match(/^Liga\s+(\d+)$/i); if (!lm) continue;
    let n = h2.nextElementSibling, table = null;
    while (n && n.tagName !== 'H2') { table = n.tagName === 'TABLE' ? n : n.querySelector && n.querySelector('table'); if (table) break; n = n.nextElementSibling; }
    if (!table) continue;
    const head = [...table.querySelectorAll('th')].map(txt);
    const iPts = head.findIndex(h => /Počet bodů/i.test(h));
    const teams = [];
    for (const tr of table.querySelectorAll('tr')) {
      const c = [...tr.querySelectorAll('td')].map(txt); if (c.length < 5) continue;
      const a = splitPlayer(c[2]), b = splitPlayer(c[4]);
      const clubs = [...new Set([a.club, b.club].filter(Boolean))].join(' / ');
      teams.push({ pos: int(c[0]), key: keyOf(a.name, b.name), p1: a.name, p2: b.name, club: clubs, index: num(c[1]), points: iPts >= 0 ? int(c[iPts]) : null });
    }
    lists[lm[1]] = teams;
  }

  // schedules: #tab_liga_N > .box (h3 + table)
  const sched = {};
  for (const tab of d.querySelectorAll('[id^="tab_liga_"]')) {
    const n = (tab.getAttribute('id').match(/tab_liga_(\d+)/) || [])[1]; if (!n) continue;
    const groups = {}, orders = {}, playoff = [];
    for (const box of tab.querySelectorAll('.box')) {
      const h = txt(box.querySelector('h3')); const table = box.querySelector('table'); if (!h || !table) continue;
      const rows = [...table.querySelectorAll('tr')].map(tr => [...tr.children].map(txt));
      let m;
      if ((m = h.match(/^Tabulka zápasů - skupina\s+(\S+)/i))) {
        groups[m[1]] = rows.slice(1).map(r => r[0]).filter(Boolean);
      } else if ((m = h.match(/^Pořadí zápasů - skupina\s+(\S+)/i))) {
        orders[m[1]] = rows.slice(1).filter(r => r.length >= 5).map(r => ({ round: int(r[0]), no: int(r[1]), a: r[2], b: r[3], ...parseResult(r[4]) }));
      } else {
        for (const r of rows.slice(1)) if (r.length >= 5) playoff.push({ stage: h, round: int(r[0]), no: int(r[1]), a: r[2], b: r[3], ...parseResult(r[4]) });
      }
    }
    sched[n] = { groups, orders, playoff };
  }
  return { id, date, start, kolo, venue, category, letni, total, lists, sched };
}

// "Němcová, Hnátová" -> team key from the pair list
function labelMatcher(teams) {
  const map = new Map();
  for (const t of teams) { const s = [lastWord(t.p1), lastWord(t.p2)].map(fold).sort().join('|'); map.set(s, t.key); }
  return label => {
    if (!label) return null;
    const parts = nfc(label).split(',').map(x => lastWord(x)).map(fold).sort().join('|');
    if (map.has(parts)) return map.get(parts);
    const one = nfc(label).split(',').map(x => fold(lastWord(x)));
    for (const t of teams) { const s = [lastWord(t.p1), lastWord(t.p2)].map(fold); if (one.every(x => s.includes(x))) return t.key; }
    return null;
  };
}

// Build the data.json tournament object (only leagues with one of the girls)
export function buildPvsTournament(parsed, url, today) {
  const leagues = [];
  for (const [n, list] of Object.entries(parsed.lists).sort((a, b) => +a[0] - +b[0])) {
    if (!list.some(t => isGirl(t.p1) || isGirl(t.p2))) continue;
    const s = parsed.sched[n] || { groups: {}, orders: {}, playoff: [] };
    const toKey = labelMatcher(list);
    const gnames = Object.keys(s.groups).sort();
    const groups = gnames.map(g => ({ name: g, teams: s.groups[g].map(toKey).filter(Boolean), matches: (s.orders[g] || []).map(m => ({ round: m.round, no: m.no, court: null, a: toKey(m.a), b: toKey(m.b), sets: m.sets, points: m.points })) }));
    const playoff = s.playoff.map(m => ({ stage: m.stage, round: m.round, no: m.no, court: null, a: toKey(m.a), b: toKey(m.b), sets: m.sets, points: m.points }));
    const anyPoints = list.some(t => t.points != null);
    let teams, seedNote;
    if (anyPoints && groups.length) { // after the event the site re-sorts the list by result
      const slot = seedsFromGroups(groups);
      const ordered = [...list].sort((a, b) => (slot[a.key] ?? 1e6 + a.pos) - (slot[b.key] ?? 1e6 + b.pos));
      teams = ordered.map((t, i) => ({ seed: i + 1, key: t.key, p1: t.p1, p2: t.p2, club: t.club, index: t.index, points: t.points }));
      seedNote = 'reconstructed';
    } else {
      teams = list.map((t, i) => ({ seed: i + 1, key: t.key, p1: t.p1, p2: t.p2, club: t.club, index: t.index, points: t.points }));
    }
    const lg = { name: `Liga ${n}`, teams, official: groups.length ? { groups, playoff } : null };
    if (seedNote) lg.seedNote = seedNote;
    leagues.push(lg);
  }
  const series = parsed.letni ? 'leto' : 'pbl';
  return {
    id: `pvs-${parsed.id}`, source: 'pvs', series, url,
    name: `${series === 'leto' ? 'Letní beachliga' : 'Pražská beachliga'} ${parsed.category}`,
    round: series === 'pbl' && parsed.kolo ? `${parsed.kolo}. kolo ${seasonOf(parsed.date)}` : null,
    category: parsed.category, date: parsed.date, start: parsed.start, venue: parsed.venue,
    status: statusFor(parsed.date, today), system: 'pvs', teamsTotal: parsed.total, leagues
  };
}

// Upcoming list on /beach/ : rows [Název, Začátek, Registrace do, Kategorie, Počet týmů, Místo, Detail]
export function parsePvsUpcoming(html, parseHTML) {
  const d = parseHTML(html); const out = [];
  for (const tr of d.querySelectorAll('table tr')) {
    const c = [...tr.querySelectorAll('td')]; if (c.length < 6) continue;
    const a = tr.querySelector('a[href*="/beach/detail/"]'); if (!a) continue;
    const id = (a.getAttribute('href').match(/detail\/(\d+)/) || [])[1];
    const dm = txt(c[1]).match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/); if (!dm) continue;
    out.push({ id, name: txt(c[0]), date: `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`, cat: txt(c[3]) });
  }
  return out;
}
// girls' and mixed youth categories (not boys, not adults)
export const girlsCategory = c => /^U(10|12|14|16|18|20)/i.test(c) && !/M$/i.test(c) || /MIX/i.test(c);

// season ranking /beach/result/{id}?type=A : rows [#, name, club, points]
export function parsePvsRanking(html, parseHTML) {
  const d = parseHTML(html);
  const rows = [...d.querySelectorAll('table tr')].slice(1).map(tr => { const tds = [...tr.querySelectorAll('td')]; const a = tds[1] && tds[1].querySelector('a'); return { c: tds.map(txt), href: a ? a.getAttribute('href') : null }; }).filter(r => r.c.length >= 4);
  return { of: rows.length, rows: rows.map(({ c, href }) => ({ rank: int(c[0]), name: c[1], club: c[2], points: num(c[3]), href })) };
}
// ABV categories a girl no longer plays (hidden in the app, never used for her profile link)
export const ABV_EXCLUDE = { 'Helena Hnátová': ['ZKY'] };
export const ABV_ORDER = ['ZKY', 'KKY', 'JKY', 'Z'];

/* =============== ČVS (cvf.cz) =============== */

// tournament list rows: [Turnaj(link), Místo, Datum od, Složka, KAT, ..., Přihlášených dvojic]
export function parseCvfList(html, parseHTML) {
  const d = parseHTML(html); const out = [];
  for (const tr of d.querySelectorAll('table tr')) {
    const c = [...tr.querySelectorAll('td')].map(txt); if (c.length < 5) continue;
    const a = tr.querySelector('a[href*="tournamentId"]'); if (!a) continue;
    const id = (a.getAttribute('href').match(/tournamentId=(\d+)/) || [])[1];
    const dm = c[2].match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/); if (!dm) continue;
    out.push({ id, name: c[0], place: c[1], date: `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`, folder: c[3], cat: c[4] });
  }
  return out;
}
// only national ABV tournaments marked celostátní, or MČR, youth women
export const cvfCandidate = r => /národní/i.test(r.folder) && /U(14|16|18|20)\s*(ženy|dívky)/i.test(r.cat) && (/celostátní/i.test(r.name) || /MČR|Mistrovství/i.test(r.name));

export function parseCvfDetail(html, parseHTML) {
  const d = parseHTML(html);
  const h1 = txt(d.querySelector('h1'));
  const body = txt(d.querySelector('main') || d.body);
  const [title, place] = h1.split(' / ').map(x => (x || '').trim());
  const dm = body.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  const date = dm ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}` : null;
  const kat = (body.match(/kategorie:\s*(U\d{2}\s*(?:ženy|dívky))/i) || [])[1] || (title.match(/U\d{2}/) || [''])[0] + ' ženy';
  const sheetA = [...d.querySelectorAll('a')].find(a => /docs\.google\.com\/spreadsheets/.test(a.getAttribute('href') || ''));
  const sheet = sheetA ? sheetA.getAttribute('href') : null;
  const level = ((title.match(/\((celostátní|oblastní)[^)]*\)/i) || [])[1] || (/Mistrovství|MČR/i.test(title) ? 'MČR' : '')).toLowerCase().replace('mčr', 'MČR') || null;
  const name = title.replace(/\s*\((celostátní|oblastní)[^)]*\)\s*/i, ' ').replace(/\s+/g, ' ').trim() + (/ženy/i.test(title) ? '' : ' ženy');
  // registered pairs (before the sheet exists): any table whose rows hold two "Jméno" columns
  const pairs = [];
  for (const t of d.querySelectorAll('table')) {
    const head = [...t.querySelectorAll('th')].map(txt);
    const iN = head.reduce((a, h, i) => (/^Jméno$/i.test(h) ? a.concat(i) : a), []);
    if (iN.length < 2) continue;
    const iB = head.findIndex(h => /^Body/i.test(h));
    for (const tr of t.querySelectorAll('tr')) { if (!tr.querySelector('td')) continue; const c = [...tr.querySelectorAll('td')].map(txt); if (c.length > iN[1]) pairs.push({ p1: c[iN[0]], p2: c[iN[1]], index: iB >= 0 ? num(c[iB]) : null }); }
    break;
  }
  return { title, place, date, category: catNorm(kat), sheet, level, name, pairs, girls: hasGirl(body) };
}

// minimal CSV parser (gviz output: every field quoted)
export function parseCSV(s) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; } else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (ch !== '\r') f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
export const sheetId = url => (String(url || '').match(/spreadsheets\/d\/([\w-]+)/) || [])[1];
export const gvizUrl = (id, sheet) => `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`;
// sheets write either "First Last" or "Last First" (decided per sheet by majority of surname-looking tokens)
const surnameLike = w => /(ová|ská|cká|á|ů)$/i.test(w);
export function surnameFirst(names) { let f = 0, l = 0; for (const n of names) { const t = nfc(n).trim().split(/\s+/); if (t.length < 2) continue; if (surnameLike(t[0])) f++; if (surnameLike(t[t.length - 1])) l++; } return f > l; }
export function personName(n, sf) { const t = nfc(n).trim().split(/\s+/); if (sf && t.length >= 2) t.push(t.shift()); return t.join(' '); }
const rawPersons = s => nfc(s).split('/').map(x => x.trim()).filter(Boolean);
const pairName = (s, sf) => rawPersons(s).map(x => personName(x, sf));

// startovní listina: [č., "First Last / First Last", Body, Poznámka]
export function parseStartList(rows) {
  const data = rows.filter(r => int(r[0]) && r[1] && r[1].includes('/'));
  const sf = surnameFirst(data.flatMap(r => rawPersons(r[1])));
  const teams = [];
  for (const r of data) {
    const [p1, p2] = pairName(r[1], sf);
    const t = { seed: int(r[0]), key: keyOf(p1, p2), p1, p2, club: '', index: num(r[2]) };
    if (r[3] && r[3].trim()) t.note = r[3].trim();
    teams.push(t);
  }
  teams.surnameFirst = sf;
  return teams;
}
// utkání rows: [Č., Kolo, Datum, Čas, Hř., Tým 1, vs, Tým 2, s1, :, s2, (, v1, ',', v2, ',', v3, ), ..., c22-24 team1 pts, c25-27 team2 pts]
export function parseMatches(rows, teams) {
  const byName = new Map(teams.map(t => [fold(`${t.p1} / ${t.p2}`), t.key]));
  const byLast = new Map(teams.map(t => [[lastWord(t.p1), lastWord(t.p2)].map(fold).sort().join('|'), t.key]));
  const sf = !!teams.surnameFirst;
  const key = s => { if (!s || !s.trim()) return null; const k = byName.get(fold(s)); if (k) return k; const [a, b] = pairName(s, sf); return a && b ? byLast.get([lastWord(a), lastWord(b)].map(fold).sort().join('|')) || null : null; };
  const out = [];
  for (const r of rows) {
    const no = int(r[0]); if (!no || !r[1]) continue;
    const s1 = r[8], s2 = r[10];
    const sets = s1 !== '' && s1 != null && s2 !== '' && s2 != null && /^\d+$/.test(String(s1).trim()) && /^\d+$/.test(String(s2).trim()) ? `${String(s1).trim()}:${String(s2).trim()}` : null;
    let points = null;
    if (sets) {
      const a = [r[22], r[23], r[24]].map(int), b = [r[25], r[26], r[27]].map(int);
      let ps = [];
      for (let i = 0; i < 3; i++) if (a[i] != null && b[i] != null && (a[i] || b[i])) ps.push(`${a[i]}:${b[i]}`);
      if (!ps.length) { // derive from the signed per-set values (team 1 view)
        [r[12], r[14], r[16]].forEach((v, i) => { const n = int(v); if (n == null) return; const T = i < 2 ? 21 : 15; const w = Math.max(T, Math.abs(n) + 2); ps.push(n >= 0 ? `${w}:${n}` : `${Math.abs(n)}:${w}`); });
      }
      points = ps.length ? ps.join(', ') : null;
    }
    out.push({ tid: 'M' + no, no, round: String(r[1]).trim(), date: r[2] || null, time: hhmm(r[3]), court: int(r[4]), a: key(r[5]), b: key(r[7]), sets, points });
  }
  return out;
}
export function cvfSystem(stage, teams, matches) {
  const rounds = new Set(matches.map(m => m.round));
  if (stage === 'HS' && teams.length === 16 && rounds.has('A-I') && rounds.has('A-W')) return 'cvf-h16-skupmod';
  if (stage === 'HS' && teams.length === 24 && rounds.has('IV') && rounds.has('17')) return 'cvf-h24-2ko';
  if (stage === 'Q' && teams.length === 18 && rounds.has('A-I') && rounds.has('F-III')) return 'cvf-q18';
  return 'cvf';
}

/* =============== validation =============== */
export function validate(data, prev) {
  const errs = [];
  const ids = new Set();
  for (const t of data.tournaments) {
    if (ids.has(t.id)) errs.push('duplicate id ' + t.id); ids.add(t.id);
    for (const l of t.leagues || []) {
      const keys = new Set(l.teams.map(x => x.key));
      const ms = [...((l.official && l.official.groups) || []).flatMap(g => g.matches), ...((l.official && l.official.playoff) || []), ...((l.official && l.official.matches) || [])];
      for (const m of ms) for (const k of [m.a, m.b]) if (k && !keys.has(k)) errs.push(`${t.id} ${l.name}: unknown team ${k}`);
      if (t.status !== 'finished' && !l.teams.some(x => isGirl(x.p1) || isGirl(x.p2))) errs.push(`${t.id} ${l.name}: no girl in a not-finished league`);
    }
  }
  if (prev && data.tournaments.length < prev.tournaments.length) errs.push(`tournament count dropped ${prev.tournaments.length} -> ${data.tournaments.length}`);
  if (!data.profiles) errs.push('profiles missing');
  return errs;
}
