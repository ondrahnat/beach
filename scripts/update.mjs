// Hnátová Beach Draw - data refresh. Run: node scripts/update.mjs [data.json]
// Refresh window today-14 .. today+14 (Europe/Prague): re-read every tournament in that window,
// discover upcoming tournaments the girls registered for, refresh rankings. Writes data.json only on change.
import fs from 'node:fs';
import { DOMParser } from 'linkedom';
import * as L from './lib.mjs';

const FILE = process.argv[2] || 'data.json';
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
  const pvs = {}, abv = {};
  for (const [cat, id] of PVSR) {
    const url = `${L.PVS}/beach/result/${id}?type=A`;
    const html = await get(url); if (!html) { pvs.failed = true; continue; }
    const r = L.parsePvsRanking(html, parseHTML);
    for (const row of r.rows) if (L.isGirl(row.name)) (pvs[L.girlName(row.name)] ||= []).push({ cat, season, rank: row.rank, of: r.of, points: row.points, url });
  }
  for (const [cat, code] of ABV) {
    const url = `${L.CVF}/beachvolejbal/zebricek?rankingItemLister-vp-page=1&rankingItemLister-filter%5BfolderId%5D=2&rankingItemLister-filter%5BrankingId%5D=${code}&rankingItemLister-filter%5Bname%5D=Hn%C3%A1tov%C3%A1`;
    const html = await get(url); if (!html) { abv.failed = true; continue; }
    const r = L.parsePvsRanking(html, parseHTML); // same 4-column shape: #, name, club, points
    for (const row of r.rows) if (L.isGirl(row.name)) (abv[L.girlName(row.name)] ||= []).push({ cat, code, rank: row.rank, points: row.points, url });
  }
  const out = JSON.parse(JSON.stringify(profiles));
  for (const p of out.players) {
    if (!pvs.failed) p.pvs = pvs[p.name] || [];
    if (!abv.failed) p.abv = abv[p.name] || [];
  }
  if (!pvs.failed || !abv.failed) out.asOf = today;
  return out;
}

/* ---------------- main ---------------- */
const prev = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const data = JSON.parse(JSON.stringify(prev));
log(`today ${today}, window ${FROM} .. ${TO}, ${data.tournaments.length} tournaments`);

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
for (const n of [...await pvsDiscover(known), ...await cvfDiscover(known)]) { data.tournaments.push(n); known.add(n.id); }
for (const t of data.tournaments) t.status = L.statusFor(t.date, today);
try { data.profiles = await rankings(data.profiles); } catch (e) { log('  ! rankings failed: ' + e.message); }

const errs = L.validate(data, prev);
if (errs.length) { console.error('VALIDATION FAILED:\n' + errs.join('\n')); process.exit(1); }
const strip = d => JSON.stringify({ ...d, updatedAt: null });
if (strip(data) === strip(prev)) { log('no changes'); process.exit(0); }
data.updatedAt = L.pragueIso();
fs.writeFileSync(FILE, JSON.stringify(data));
log(`data.json updated (${data.tournaments.length} tournaments)`);
