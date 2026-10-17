/* ================================================================
   D/ST Streamer — data access layer.
   Game data is served SAME-ORIGIN from /data/*.json.gz (kept fresh by a
   nightly GitHub Action running scripts/refresh_data.py — no third-party
   CORS dependencies). Sleeper + Open-Meteo remain live API calls (both
   send proper CORS headers). Parsed payloads cached in localStorage ~12h.
   ================================================================ */
const Store = {
    get(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj || typeof obj.ts !== 'number') return null;
            if ((Date.now() - obj.ts) > CFG.CACHE_TTL_HOURS * 3600e3) return null;
            return obj.data;
        } catch (e) { return null; }
    },
    put(key, data) {
        try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); }
        catch (e) { /* quota — memory cache still serves this session */ }
    },
};
const MemCache = new Map();

async function fetchBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return new Uint8Array(await res.arrayBuffer());
}
async function gunzip(bytes) {
    if (!(bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b))
        return new TextDecoder().decode(bytes);          // plain json fallback
    if (typeof DecompressionStream === 'undefined')
        throw new Error('This browser cannot read .gz files (needs Safari 16+/Chrome).');
    const ds = new Response(new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream('gzip')));
    return await ds.text();
}
async function loadJsonGz(url) {
    return JSON.parse(await gunzip(await fetchBytes(url)));
}

/* Per-season database (memory + localStorage persistence). */
const YDB = { games: new Map(), stats: new Map(), done: new Set(), busy: new Map() };

async function loadOnce(key, urlFactory) {
    const mem = MemCache.get(key);
    if (mem) return mem;
    const ls = Store.get(key);
    if (ls) { MemCache.set(key, ls); return ls; }
    const data = await loadJsonGz(urlFactory());
    MemCache.set(key, data); Store.put(key, data);
    return data;
}
/* Ensure one season's games + stats are loaded. Safe to await concurrently. */
function ensureYear(season) {
    if (YDB.done.has(season)) return Promise.resolve(true);
    if (YDB.busy.has(season)) return YDB.busy.get(season);
    const p = (async () => {
        const gkey = `ds:g:${season}:v2`, skey = `ds:s:${season}:v2`;
        let games = [];
        try { games = await loadOnce(gkey, () => `${CFG.DATA.local}games_${season}.json.gz`); }
        catch (e) { console.warn(`no games for ${season}`, e.message); }
        let stats = [];
        try { stats = await loadOnce(skey, () => `${CFG.DATA.local}stats_${season}.json.gz`); }
        catch (e) { console.warn(`no stats for ${season}`, e.message); }
        for (const g of games) YDB.games.set(g.gid, g);
        if (stats.length) YDB.stats.set(season, stats);
        if (games.length && stats.length) YDB.done.add(season);
        return true;
    })().finally(() => YDB.busy.delete(season));
    YDB.busy.set(season, p);
    return p;
}
/* Games rows only (for schedule questions like week pickers without history). */
async function loadSeasonGames(season) {
    try { return await loadOnce(`ds:g:${season}:v2`, () => `${CFG.DATA.local}games_${season}.json.gz`); }
    catch (e) { return []; }
}
async function ensureYears(from, to, onProgress) {
    const need = [];
    for (let s = from; s <= to; s++) if (!YDB.done.has(s)) need.push(s);
    let done = 0;
    const POOL = 6;
    let i = 0;
    async function worker() {
        while (i < need.length) {
            const s = need[i++];
            await ensureYear(s);
            if (onProgress) onProgress(`Loaded ${++done}/${need.length} season datasets`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, need.length) || 1 }, worker));
}
async function loadMeta() {
    try {
        return await loadOnce('ds:meta:v2', () => `${CFG.DATA.local}meta.json.gz`);
    } catch (e) { return null; }
}

/* Build chronological per-team-game records joining box stats with scores. */
function buildRecords(statsBySeason) {
    const recs = [];
    for (const [seasonStr, rows] of statsBySeason) {
        const season = Number(seasonStr);
        const byGid = new Map();
        for (const t of rows) {
            let e = byGid.get(t.gid);
            if (!e) byGid.set(t.gid, e = {});
            e[t.team] = t;
        }
        for (const [gid, sides] of byGid) {
            const g = YDB.games.get(gid);
            if (!g || g.as === null || g.hs === null) continue;     // unplayed
            const a = sides[g.away], h = sides[g.home];
            if (!a || !h || a.post || h.post) continue;             // regular season only
            const neutral = g.loc === 'Neutral';
            for (const [t, row, o, venue, pf, pa] of [
                [g.away, a, h, 'A', g.as, g.hs],
                [g.home, h, a, 'H', g.hs, g.as],
            ]) {
                recs.push({
                    season: g.season, week: g.week, date: g.date,
                    team: t, opp: t === g.away ? g.home : g.away,
                    venue: neutral ? 'N' : venue, roof: g.roof, stadium: g.stadium,
                    pf, pa,
                    give: row.oi + row.ol, sackSuf: row.osk, att: row.oa,
                    playsF: row.oa + row.osk + row.opc,
                    ydsF: row.opy + row.ory + row.osy,
                    d_sacks: row.dsk, d_int: o.oi, d_ff: row.dff, d_fr: o.ol,
                    d_td: row.dtd, st_td: row.std, d_safe: row.dsa, d_blk: row.dbk,
                });
            }
        }
    }
    recs.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : (x.team < y.team ? -1 : 1));
    return recs;
}

/* Actual D/ST fantasy points given a scoring config. */
function tierPts(tiers, pa) {
    let v = 0;
    for (const [lb, p] of tiers) if (pa >= lb) v = p;
    return v;
}
function actualDefPoints(r, cfg) {
    return tierPts(cfg.tiers, r.pa)
        + cfg.sack * r.d_sacks + cfg.int * r.d_int + cfg.ff * r.d_ff + cfg.fr * r.d_fr
        + cfg.def_td * r.d_td + cfg.st_td * r.st_td
        + cfg.safety * r.d_safe + cfg.blk_kick * r.d_blk;
}

/* ---------------- Sleeper helpers (v1 endpoints) ---------------- */
async function sleeper(path) {
    const res = await fetch(CFG.DATA.sleeperApi + path);
    if (!res.ok) throw new Error(`Sleeper HTTP ${res.status}: ${path}`);
    return await res.json();
}
const sleeperState = () => sleeper('/state/nfl');
const defPlayerMap = async () => {
    const key = 'ds:sleeperdef:v1';
    const c = Store.get(key) || MemCache.get(key);
    if (c) return c;
    const data = await sleeper('/players/nfl?position=DEF');
    MemCache.set(key, data); Store.put(key, data);
    return data;
};
const userObj = (u) => sleeper(`/user/${encodeURIComponent(u)}`);
const userLeagues = (uid, season) => sleeper(`/user/${uid}/leagues/nfl/${season}`).catch(() => []);
const leagueDetail = (lid) => sleeper(`/league/${lid}`);
const leagueRosters = (lid) => sleeper(`/league/${lid}/rosters`);

/* ---------------- Weather (Open-Meteo, no key) ---------------- */
async function fetchWeather(points, dates) {
    const uniqCoords = [];
    const seenC = new Set();
    for (const p of points) {
        const k = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
        if (!seenC.has(k)) { seenC.add(k); uniqCoords.push({ ...p, k }); }
    }
    const start = dates.slice().sort()[0], end = dates.slice().sort().pop();
    const out = {};
    const BATCH = 8;
    try {
        for (let i = 0; i < uniqCoords.length; i += BATCH) {
            const chunk = uniqCoords.slice(i, i + BATCH);
            const url = `${CFG.DATA.openMeteo}?latitude=${chunk.map(c => c.lat).join(',')}` +
                `&longitude=${chunk.map(c => c.lng).join(',')}` +
                `&daily=wind_speed_10m_max,precipitation_sum&timezone=auto` +
                `&start_date=${start}&end_date=${end}`;
            const res = await fetch(url);
            if (!res.ok) continue;
            const j = await res.json();
            const arrs = Array.isArray(j) ? j : [j];
            arrs.forEach((one, ci) => {
                const c = chunk[ci];
                if (!one || !one.daily) return;
                one.daily.time.forEach((d, di) => {
                    out[`${c.k}|${d}`] = {
                        windKmH: one.daily.wind_speed_10m_max?.[di] ?? 0,
                        precipMm: one.daily.precipitation_sum?.[di] ?? 0,
                    };
                });
            });
        }
    } catch (e) { console.warn('weather unavailable', e); }
    return out;
}
function weatherFactor(wx, indoor) {
    if (!wx || indoor) return { f: 1, wind: 0, rain: 0 };
    let f = 1;
    for (const [th, m] of CFG.WEATHER.windKmH) { if (wx.windKmH >= th) { f *= m; break; } }
    for (const [th, m] of CFG.WEATHER.precipMm) { if (wx.precipMm >= th) { f *= m; break; } }
    f = Math.max(CFG.WEATHER.minFloor, f);
    return { f, wind: wx.windKmH / 3.6, rain: wx.precipMm };
}
