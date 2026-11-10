// Beach Draw - data refresh. Run: node scripts/update.mjs [data.json] [--history]
// Players come from config.json. Refresh window today-14 .. today+14 (Europe/Prague): re-read every tournament
// in that window, discover upcoming tournaments the players registered for, refresh rankings.
// --history (or a player new in config.json, or no data.json yet) also walks the archives back to
// config.historyFrom and adds every past tournament of the players. Writes data.json only on change.
import fs from 'node:fs';
import { DOMParser } from 'linkedom';
import * as L from './lib.mjs';

const FILE = process.argv.slice(2).find(a => !a.startsWith('--')) || 'data.json';
const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
if (!Array.isArray(CONFIG.players) || !CONFIG.players.length || CONFIG.players.some(p => !p || !String(p.name || '').trim().includes(' '))) {
  console.error('config.json: "players" musí obsahovat aspoň jednu hráčku se jménem a příjmením'); process.exit(1);
}
L.setPlayers(CONFIG.players);
const HISTORY_FROM = /^\d{4}-\d{2}-\d{2}$/.test(CONFIG.historyFrom || '') ? CONFIG.historyFrom : '2022-08-01';
const parseHTML = html => new DOMParser().parseFromString(html, 'text/html');
const today = process.env.TODAY || L.pragueToday();
const FROM = L.addDays(today, -14), TO = L.addDays(today, 14);
const log = (...a) => console.log(...a);

async function get(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (HnatovaBeachDraw; +https://ondrahnat.github.io/beach/)', 'Accept-Language': 'cs' } });
      if (r.ok) return await r.text();
      log(`  ! ${r.status} ${url}`);
      if (r.status === 404) return null;
    } catch (e) { log(`  ! ${e.message} ${url}`); }
    await new Promise(res => setTimeout(res, 1500 * i));
  }
  return null;
}

/* ---------------- PVS ---------------- */
async function pvsTournament(id) {
  const url = `${L.PVS}/beach/detail/${id}`;
  const html = await get(url); if (!html) return null;
  const parsed = L.parsePvsDetail(html, id, parseHTML);
  if (!parsed.date) { log(`  ! no date on ${url}`); return null; }
  return L.buildPvsTournament(parsed, url, today);
}

async function pvsDiscover(known) {
  const found = [];
  const pages = [`${L.PVS}/beach/`, `${L.PVS}/beach/?grid-page=2&grid-sort%5BstartDate%5D=asc&grid-sort%5Bname%5D=asc&do=grid-page`, `${L.PVS}/beach/?grid-page=3&grid-sort%5BstartDate%5D=asc&grid-sort%5Bname%5D=asc&do=grid-page`];
  for (const p of pages) {
    const html = await get(p); if (!html) break;
    const rows = L.parsePvsUpcoming(html, parseHTML);
    for (const r of rows) if (r.date >= today && r.date <= TO && L.girlsCategory(r.cat) && !known.has(`pvs-${r.id}`)) found.push(r);
    if (!rows.length || rows[rows.length - 1].date > TO) break;
  }
  const out = [];
  for (const r of found) {
    const t = await pvsTournament(r.id);
    if (t && t.leagues.length) { log(`  + discovered ${t.id} ${t.date} ${t.name}`); out.push(t); }
  }
  log(`PVS discovery: checked ${found.length}, added ${out.length}`);
  return out;
}

/* ---------------- ČVS ---------------- */
async function cvfTournament(id, url) {
  url = url || `${L.CVF}/beachvolejbal/turnaje?tournamentId=${id}`;
  const html = await get(url); if (!html) return null;
  const info = L.parseCvfDetail(html, parseHTML);
  if (!info.date) return null;
  const t = { id: `cvf-${id}`, source: 'cvf', series: 'abv', url, name: info.name, round: info.level, category: info.category, date: info.date, start: null, venue: (info.place || '').replace(/\s*\((.*)\)\s*$/, ', $1') || null, status: L.statusFor(info.date, today), system: 'cvf', teamsTotal: null, leagues: [] };
  if (info.sheet) t.sheet = info.sheet;
  const sid = L.sheetId(info.sheet);
  let total = 0;
  if (sid) {
    for (const [stage, name] of [['Q', 'Kvalifikace'], ['HS', 'Hlavní soutěž']]) {
      const sl = await get(L.gvizUrl(sid, `${stage} - startovní listina`), 1);
      if (!sl || /<html/i.test(sl.slice(0, 200))) continue;
      const teams = L.parseStartList(L.parseCSV(sl));
      if (!teams.length) continue;
      total += teams.length;
      const ut = await get(L.gvizUrl(sid, `${stage} - utkání`), 1);
      const matches = ut && !/<html/i.test(ut.slice(0, 200)) ? L.parseMatches(L.parseCSV(ut), teams) : [];
      if (!teams.some(x => L.isGirl(x.p1) || L.isGirl(x.p2))) continue;
      t.leagues.push({ name, system: L.cvfSystem(stage, teams, matches), teams, official: matches.length ? { matches } : null });
    }
    const first = t.leagues.flatMap(l => (l.official && l.official.matches) || []).find(m => m.time);
    if (first) t.start = first.time;
  }
  if (!t.leagues.length && info.pairs.length && t.status !== 'finished') {
    const teams = info.pairs.map((p, i) => ({ seed: i + 1, key: L.keyOf(p.p1, p.p2), p1: p.p1, p2: p.p2, club: '', index: p.index }));
    if (teams.some(x => L.isGirl(x.p1) || L.isGirl(x.p2))) t.leagues.push({ name: 'Hlavní soutěž', system: 'cvf', teams, official: null });
    total = teams.length;
  }
  t.teamsTotal = total || null;
  return t;
}

function monthsInWindow() { const s = new Set(); for (let d = FROM; d <= TO; d = L.addDays(d, 7)) s.add(d.slice(0, 7)); s.add(TO.slice(0, 7)); return [...s]; }
async function cvfDiscover(known) {
  const cands = [];
  for (const ym of monthsInWindow()) {
    const [y, m] = ym.split('-').map(Number);
    for (let page = 1; page <= 5; page++) {
      const html = await get(`${L.CVF}/beachvolejbal/turnaje?tournamentLister-vp-page=${page}&tournamentLister-filter%5BfolderId%5D=2&tournamentLister-filter%5Byear%5D=${y}&tournamentLister-filter%5Bmonth%5D=${m}`);
      if (!html) break;
      const rows = L.parseCvfList(html, parseHTML);
      for (const r of rows) if (r.date >= today && r.date <= TO && L.cvfCandidate(r) && !known.has(`cvf-${r.id}`) && !cands.some(c => c.id === r.id)) cands.push(r);
      if (rows.length < 20) break;
    }
  }
  const out = [];
  for (const r of cands) { const t = await cvfTournament(r.id); if (t && t.leagues.length) { log(`  + discovered ${t.id} ${t.date} ${t.name}`); out.push(t); } }
  log(`ČVS discovery: checked ${cands.length}, added ${out.length}`);
  return out;
}

/* ---------------- rankings ---------------- */
async function rankings(profiles) {
  const season = L.seasonOf(today);
  const PVSR = [['U12Ž', 15], ['U14Ž', 4], ['U16Ž', 6], ['U18Ž', 8], ['U20Ž', 10]];
  const ABV = [['U16 ženy', 'ZKY'], ['U18 ženy', 'KKY'], ['U20 ženy', 'JKY'], ['Ženy', 'Z']];
  const pvs = {}, abv = {}, pvsWho = {};
  for (const [cat, id] of PVSR) {
    const url = `${L.PVS}/beach/result/${id}?type=A`;
    const html = await get(url); if (!html) { pvs.failed = true; continue; }
    const r = L.parsePvsRanking(html, parseHTML);
    for (const row of r.rows) if (L.isGirl(row.name)) {
      (pvs[L.girlName(row.name)] ||= []).push({ cat, season, rank: row.rank, of: r.of, points: row.points, url });
      (pvsWho[L.girlName(row.name)] ||= { club: row.club, href: row.href });
    }
  }
  for (const [cat, code] of ABV) for (const surname of L.surnames()) {
    const url = `${L.CVF}/beachvolejbal/zebricek?rankingItemLister-vp-page=1&rankingItemLister-filter%5BfolderId%5D=2&rankingItemLister-filter%5BrankingId%5D=${code}&rankingItemLister-filter%5Bname%5D=${encodeURIComponent(surname)}`;
    const html = await get(url); if (!html) { abv.failed = true; continue; }
    const r = L.parsePvsRanking(html, parseHTML); // same 4-column shape: #, name, club, points
    for (const row of r.rows) if (L.isGirl(row.name)) (abv[L.girlName(row.name)] ||= []).push({ cat, code, rank: row.rank, points: row.points, url, detail: row.href ? new URL(row.href, L.CVF).href : null });
  }
  const out = JSON.parse(JSON.stringify(profiles || {}));
  // one profile per player in config.json, in config order (new players get an empty profile)
  const old = new Map((out.players || []).map(p => [p.name, p]));
  out.players = L.PLAYERS.map(n => old.get(n) || { name: n, club: '', photo: null, pvsUrl: null, cvfUrl: null, pvs: [], abv: [] });
  for (const p of out.players) {
    const who = pvsWho[p.name];
    if (who && !p.club && who.club) p.club = who.club;
    if (who && !p.pvsUrl && who.href) p.pvsUrl = new URL(who.href, L.PVS).href;
    if (!pvs.failed) p.pvs = pvs[p.name] || [];
    if (!abv.failed) {
      p.abv = (abv[p.name] || []).map(({ detail, ...r }) => r);
      // profile link = her youngest ABV category she still plays (Helena: U18, not U16)
      const own = (abv[p.name] || []).filter(r => !(L.ABV_EXCLUDE[p.name] || []).includes(r.code) && r.detail).sort((a, b) => L.ABV_ORDER.indexOf(a.code) - L.ABV_ORDER.indexOf(b.code));
      if (own.length) p.cvfUrl = own[0].detail;
    }
  }
  if (!pvs.failed || !abv.failed) out.asOf = today;
  return out;
}

/* ---------------- history (archives back to HISTORY_FROM) ---------------- */
const hasOfficial = t => (t.leagues || []).some(l => l.official);
async function pvsHistory(known, data) {
  const ids = []; let firstPrev = null;
  for (let page = 1; page <= 80; page++) {
    const html = await get(`${L.PVS}/beach/archiv?archivGrid-page=${page}&archivGrid-sort%5BstartDate%5D=desc&do=archivGrid-page`);
    if (!html) break;
    const rows = L.parsePvsUpcoming(html, parseHTML); // same columns as the upcoming list
    if (!rows.length || rows[0].id === firstPrev) break; // past the end the site repeats the last page
    firstPrev = rows[0].id;
    for (const r of rows) if (r.date >= HISTORY_FROM && r.date < today && L.girlsCategory(r.cat)) ids.push(r.id);
    if (rows[rows.length - 1].date < HISTORY_FROM) break;
  }
  const out = []; let rescraped = 0;
  for (const id of [...new Set(ids)]) {
    const old = data.tournaments.find(t => t.id === `pvs-${id}`);
    if (old && hasOfficial(old)) continue; // already complete
    const t = await pvsTournament(id);
    if (!t || !t.leagues.length) continue;
    if (old) { if (hasOfficial(t)) { data.tournaments[data.tournaments.indexOf(old)] = t; rescraped++; log(`  ~ matches added ${t.id} ${t.date} ${t.name}`); } continue; }
    log(`  + history ${t.id} ${t.date} ${t.name}`); out.push(t);
  }
  log(`PVS history: ${ids.length} tournaments in girls' categories, added ${out.length}, completed ${rescraped}`);
  return out;
}
async function cvfHistory(known) {
  const cands = [];
  for (let d = HISTORY_FROM.slice(0, 7) + '-01'; d < today; d = L.addDays(d, 32).slice(0, 7) + '-01') {
    const [y, m] = d.split('-').map(Number);
    for (let page = 1; page <= 5; page++) {
      const html = await get(`${L.CVF}/beachvolejbal/turnaje?tournamentLister-vp-page=${page}&tournamentLister-filter%5BfolderId%5D=2&tournamentLister-filter%5Byear%5D=${y}&tournamentLister-filter%5Bmonth%5D=${m}`);
      if (!html) break;
      const rows = L.parseCvfList(html, parseHTML);
      for (const r of rows) if (r.date >= HISTORY_FROM && r.date < today && L.cvfCandidate(r) && !known.has(`cvf-${r.id}`) && !cands.some(c => c.id === r.id)) cands.push(r);
      if (rows.length < 20) break;
    }
  }
  const out = [];
  for (const r of cands) { const t = await cvfTournament(r.id); if (t && t.leagues.length) { log(`  + history ${t.id} ${t.date} ${t.name}`); out.push(t); } }
  log(`ČVS history: checked ${cands.length}, added ${out.length}`);
  return out;
}

/* ---------------- main ---------------- */
const fresh = !fs.existsSync(FILE);
const prev = fresh ? { updatedAt: null, players: [], tournaments: [], profiles: { players: [] } } : JSON.parse(fs.readFileSync(FILE, 'utf8'));
const data = JSON.parse(JSON.stringify(prev));
const newPlayers = L.PLAYERS.filter(n => !(prev.players || []).includes(n));
const HISTORY = process.argv.includes('--history') || process.env.HISTORY === '1' || fresh || newPlayers.length > 0;
log(`today ${today}, window ${FROM} .. ${TO}, ${data.tournaments.length} tournaments, players: ${L.PLAYERS.join(', ')}${HISTORY ? `, history from ${HISTORY_FROM}` : ''}${newPlayers.length && !fresh ? ` (new: ${newPlayers.join(', ')})` : ''}`);

// players removed from config.json: drop tournaments without any configured player
const removed = (prev.players || []).filter(n => !L.PLAYERS.includes(n));
const withPlayer = t => (t.leagues || []).some(l => l.teams.some(x => L.isGirl(x.p1) || L.isGirl(x.p2)));
if (removed.length) {
  const before = data.tournaments.length;
  data.tournaments = data.tournaments.filter(withPlayer);
  for (const t of data.tournaments) t.leagues = t.leagues.filter(l => l.teams.some(x => L.isGirl(x.p1) || L.isGirl(x.p2)));
  log(`players removed: ${removed.join(', ')}; dropped ${before - data.tournaments.length} tournaments`);
}
data.players = [...L.PLAYERS];

// extra links added by hand (one URL per line in extra-links.txt)
const extra = fs.existsSync('extra-links.txt') ? fs.readFileSync('extra-links.txt', 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => /^https?:\/\//.test(s)) : [];

const byId = new Map(data.tournaments.map((t, i) => [t.id, i]));
const known = new Set(byId.keys());
async function refresh(t) {
  if (t.source === 'pvs') return pvsTournament(t.id.replace('pvs-', ''));
  if (t.source === 'cvf') return cvfTournament(t.id.replace('cvf-', ''), /cvf\.cz\/beachvolejbal/.test(t.url) ? t.url : null);
  return null;
}
for (const t of [...data.tournaments]) {
  if (t.date < FROM || t.date > TO) continue;
  log(`refresh ${t.id} ${t.date} ${t.name}`);
  const n = await refresh(t);
  if (!n) { log('  ! kept old data'); continue; }
  if (t.status === 'finished' && !n.leagues.length && t.leagues.length) { log('  ! girls not found in a finished tournament, kept old data'); continue; }
  if (t.source === 'cvf' && t.url && !/cvf\.cz\/beachvolejbal/.test(t.url)) n.url = t.url;
  data.tournaments[byId.get(t.id)] = n;
}
for (const u of extra) {
  let m, n = null;
  if ((m = u.match(/volejbalpraha\.cz\/beach\/detail\/(\d+)/))) { if (!known.has(`pvs-${m[1]}`)) n = await pvsTournament(m[1]); }
  else if ((m = u.match(/tournamentId=(\d+)/))) { if (!known.has(`cvf-${m[1]}`)) n = await cvfTournament(m[1]); }
  if (n) { log(`  + extra ${n.id} ${n.date} ${n.name}`); data.tournaments.push(n); known.add(n.id); }
}
const discovered = [...await pvsDiscover(known), ...await cvfDiscover(known)];
if (HISTORY) {
  // discovery looks from today on; the history walk covers everything before today
  discovered.push(...await pvsHistory(known, data), ...await cvfHistory(known));
}
for (const n of discovered) if (!known.has(n.id)) { data.tournaments.push(n); known.add(n.id); }
for (const t of data.tournaments) t.status = L.statusFor(t.date, today);
try { data.profiles = await rankings(data.profiles); } catch (e) { log('  ! rankings failed: ' + e.message); }

const errs = L.validate(data, removed.length ? null : prev);
if (errs.length) { console.error('VALIDATION FAILED:\n' + errs.join('\n')); process.exit(1); }
const strip = d => JSON.stringify({ ...d, updatedAt: null });
if (!fresh && strip(data) === strip(prev)) { log('no changes'); process.exit(0); }
data.updatedAt = L.pragueIso();
fs.writeFileSync(FILE, JSON.stringify(data));
log(`data.json updated (${data.tournaments.length} tournaments)`);
