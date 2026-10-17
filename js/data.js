/* ================================================================
   D/ST Streamer — data access layer.
   Fetches nflverse games + weekly team stats (csv/csv.gz), parses and
   projects to minimal columns, caches daily in localStorage.
   Also Sleeper API helpers and Open-Meteo weather lookups.
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
        catch (e) { /* quota exceeded — memory cache still serves this session */ }
    },
};
const MemCache = new Map();

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        if (typeof DecompressionStream === 'undefined')
            throw new Error('This browser cannot decompress .csv.gz files (needs Safari 16+/Chrome).');
        const ds = new Response(
            new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')));
        return await ds.text();
    }
    return new TextDecoder().decode(buf);
}

/* Minimal RFC-4180 CSV parser (handles quoted fields with commas/newlines). */
function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQ = false;
            } else field += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
        else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}
function csvObjects(text) {
    const rows = parseCSV(text);
    const head = rows.shift();
    return rows.map(r => {
        const o = {};
        for (let i = 0; i < head.length; i++) o[head[i]] = r[i];
        return o;
    });
}
const _num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };

/* ---------------- games.csv (scores + schedule, all seasons) ---------------- */
async function loadGames(onProgress) {
    const key = 'ds:games:v1';
    const cached = Store.get(key) || MemCache.get(key);
    if (cached) return cached;
    if (onProgress) onProgress('Loading NFL schedule & scores…');
    const objs = csvObjects(await fetchText(CFG.DATA.games));
    const games = [];
    for (const r of objs) {
        const gt = r.game_type;
        if (gt === 'PRE') continue;
        games.push({
            gid: r.game_id, season: _num(r.season), week: _num(r.week),
            post: gt !== 'REG', date: r.gameday,
            away: normTeam(r.away_team), home: normTeam(r.home_team),
            as: r.away_score === '' ? null : _num(r.away_score),
            hs: r.home_score === '' ? null : _num(r.home_score),
            loc: r.location, roof: (r.roof || '').toLowerCase(), stadium: r.stadium_id || '',
        });
    }
    MemCache.set(key, games); Store.put(key, games);
    return games;
}

/* ---------------- stats_team_week_{season}.csv.gz ---------------- */
async function loadSeasonStats(season, onProgress) {
    const key = `ds:st:${season}:v1`;
    const cached = Store.get(key) || MemCache.get(key);
    if (cached) return cached;
    if (onProgress) onProgress(`Loading ${season} team box stats…`);
    const objs = csvObjects(await fetchText(CFG.DATA.statsTeam(season)));
    const rows = [];
    for (const r of objs) {
        rows.push({
            gid: r.game_id, team: normTeam(r.team), post: r.season_type === 'POST' ? 1 : 0,
            oi: _num(r.passing_interceptions),               // own offense INTs thrown
            ol: _num(r.sack_fumbles_lost) + _num(r.rushing_fumbles_lost) + _num(r.receiving_fumbles_lost),
            osk: _num(r.sacks_suffered), oa: _num(r.attempts),
            opy: _num(r.passing_yards), ory: _num(r.rushing_yards), osy: _num(r.sack_yards_lost),
            opc: _num(r.carries),
            dsk: _num(r.def_sacks), din: _num(r.def_interceptions), dff: _num(r.def_fumbles_forced),
            dtd: _num(r.def_tds), std: _num(r.special_teams_tds), dsa: _num(r.def_safeties),
            dbk: _num(r.fg_blocked) + _num(r.pat_blocked),
        });
    }
    MemCache.set(key, rows); Store.put(key, rows);
    return rows;
}

async function loadAllSeasonStats(startSeason, endSeason, onProgress) {
    const out = {};
    const seasons = [];
    for (let s = Math.max(CFG.HISTORY_MIN_SEASON, startSeason); s <= endSeason; s++) seasons.push(s);
    let done = 0;
    const POOL = 4;
    let idx = 0;
    async function worker() {
        while (idx < seasons.length) {
            const s = seasons[idx++];
            out[s] = await loadSeasonStats(s, onProgress);
            done++;
            if (onProgress) onProgress(`Loaded ${done}/${seasons.length} season files`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, seasons.length) }, worker));
    return out;
}

/* Build chronological per-team-game records joining box stats with final scores. */
function buildRecords(games, statsBySeason) {
    const gById = new Map(games.map(g => [g.gid, g]));
    const recs = [];
    for (const seasonStr of Object.keys(statsBySeason)) {
        const byGid = new Map();
        for (const t of statsBySeason[seasonStr]) {
            let e = byGid.get(t.gid);
            if (!e) byGid.set(t.gid, e = {});
            e[t.team] = t;
        }
        for (const [gid, sides] of byGid) {
            const g = gById.get(gid);
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
/* Returns map "lat,lng|date" -> {windKmH, precipMm}. Silent on failure. */
async function fetchWeather(points, dates) {
    // points: [{lat,lng}], dates: ['YYYY-MM-DD'] within forecast window
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
