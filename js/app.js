/* ================================================================
   D/ST Streamer — UI orchestration.
   ================================================================ */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';

const APP = {
    games: null, recs: null, events: null, recIdx: new Map(),
    loadedRange: null,            // [startSeason, endSeason] currently in memory
    histStart: CFG.HISTORY_DEFAULT_START,
    lastSlate: null,              // projection bundles for re-render without refetch
    lastTracker: null,
    leagueCtx: null,              // {user, league, rosters, users, scoring, owners:Set, faDefs:Set}
    defIds: null,                 // Sleeper virtual-DEF player ids
    todayISO: new Date().toISOString().slice(0, 10),
    wxCache: { key: '', data: {} },
};

/* ---------------- tiny UI helpers ---------------- */
function setStatus(sel, msg, kind = '') {
    const el = $(sel);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status-line ' + kind;
}
function withProgress(sel, fn) { const p = $(sel); p.hidden = false; fn.finally(() => p.hidden = true); return fn(); }

/* ---------------- tabs ---------------- */
$$('.tab-btn').forEach(b => b.addEventListener('click', () => {
    $$('.tab-btn').forEach(x => x.classList.toggle('active', x === b));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
}));

/* ---------------- selects ---------------- */
function fillSelect(sel, items, val) {
    sel.innerHTML = items.map(i => `<option value="${i.v}">${i.l}</option>`).join('');
    if (val !== undefined) sel.value = String(val);
}
function seasonOptions() {
    const cur = APP.currentSeason || 2026;
    const out = [];
    for (let s = cur + 1; s >= CFG.HISTORY_MIN_SEASON; s--) out.push({ v: s, l: s });
    return out;
}
async function refreshWeekOptions() {
    const season = +$('#selSeason').value;
    let weeks = [];
    let rows = gamesForSeason(season);
    if (!rows.length) rows = await loadSeasonGames(season);      // small single-file fetch
    weeks = [...new Set(rows.map(g => g.week))].sort((a, b) => a - b);
    if (!weeks.length) weeks = Array.from({ length: 18 }, (_, i) => i + 1);
    const cur = +$('#selWeek').value;
    fillSelect($('#selWeek'), weeks.map(w => ({ v: w, l: 'Week ' + w })), weeks.includes(cur) ? cur : weeks[Math.floor(weeks.length / 3)] || 1);
}
function refreshScoringOptions() {
    const sel = $('#selScoring');
    let opts = SCORING_PRESETS.map(p => ({ v: p.id, l: p.label }));
    if (APP.leagueCtx?.scoring) opts.unshift({ v: 'league', l: `Your league (${APP.leagueCtx.league.name})` });
    const cur = sel.value;
    fillSelect(sel, opts, opts.some(o => o.v === cur) ? cur : 'sleeper');
}
function currentCfg() {
    const id = $('#selScoring').value;
    const sacks = $('#chkSacks').checked;
    if (id === 'league' && APP.leagueCtx?.scoring)
        return scoringFromSleeperSettings(APP.leagueCtx.scoring, sacks);
    const p = SCORING_PRESETS.find(x => x.id === id) || SCORING_PRESETS[0];
    return sacks ? p : { ...p, sack: 0 };
}

/* ---------------- data plumbing ---------------- */
async function ensureData(targetSeason, forceStart) {
    const start = Math.max(CFG.HISTORY_MIN_SEASON,
        Math.min(forceStart ?? APP.histStart, targetSeason - 5));
    const end = targetSeason;
    setStatus('#startStatus', `Loading ${start}–${end} datasets…`);
    await ensureYears(start, end, m => setStatus('#startStatus', m));
    rebuildRecords();
    applyView(start, end);
}
function rebuildRecords() {
    const subset = [...YDB.stats.entries()].sort((a, b) => a[0] - b[0]);
    APP.recsFull = buildRecords(subset);
}
function applyView(start, end) {
    if (!APP.recsFull) rebuildRecords();
    APP.recs = APP.recsFull.filter(r => r.season >= start && r.season <= end);
    APP.events = buildWeekEvents(APP.recs);
    APP.recIdx = new Map(APP.recs.map(r => [`${r.season}:${r.week}:${r.team}`, r]));
    APP.loadedRange = [start, end];
}
function gamesForSeason(season) {
    return [...YDB.games.values()].filter(g => g.season === season && !g.post);
}

/* ---------------- weekly advice ---------------- */
async function analyzeWeek(auto = false) {
    const season = +$('#selSeason').value, week = +$('#selWeek').value;
    const btn = $('#btnAnalyze');
    btn.disabled = true;
    try {
        setStatus('#startStatus', 'Preparing…');
        await ensureData(season);
        const cfg = currentCfg();
        const { tracker } = trainTracker(APP.events, season, week);
        APP.lastTracker = tracker;

        const fixtures = gamesForSeason(season).filter(g => g.week === week);
        const bundles = [];
        for (const g of fixtures) {
            const neutral = g.loc === 'Neutral';
            for (const [defT, offT, venue] of [[g.away, g.home, neutral ? 'N' : 'A'], [g.home, g.away, neutral ? 'N' : 'H']]) {
                const pr = predictParams(tracker, CFG.MODEL.K, CFG.MODEL.Kv, defT, offT, venue);
                if (!pr) continue;
                const played = g.as !== null;
                const raw = APP.recIdx.get(`${season}:${week}:${defT}`);
                bundles.push({ g, defT, offT, venue, pr, prRaw: { ...pr },
                    played, actual: raw ? actualDefPoints(raw, cfg) : null, raw,
                    wx: null });
            }
        }
        if (!bundles.length) {
            setStatus('#startStatus', `No scheduled games found for ${season} week ${week}.`, 'warn');
            $('#startTable tbody').innerHTML = `<tr><td colspan="10" class="empty">Nothing scheduled.</td></tr>`;
            return;
        }

        // ---- weather (outdoor games soon, graceful) ----
        if ($('#chkWeather').checked) {
            const horizon = new Date(Date.now() + CFG.WEATHER.forecastWindowDays * 864e5).toISOString().slice(0, 10);
            const pts = [], dates = new Set();
            for (const b of bundles) {
                if (b.played || b.g.date > horizon) continue;
                const vd = venueInfo(b.g);
                if (!vd || vd.dome) continue;
                pts.push(vd); dates.add(b.g.date);
            }
            if (pts.length && dates.size) {
                setStatus('#startStatus', 'Checking wind & rain forecasts…');
                const key = [...dates].sort().join(',') + '|' + pts.map(p => `${p.lat},${p.lng}`).join(';');
                if (APP.wxCache.key !== key) APP.wxCache = { key, data: await fetchWeather(pts, [...dates]) };
                for (const b of bundles) {
                    const vd = venueInfo(b.g);
                    if (!vd || vd.dome || !b.g.date) continue;
                    const wx = APP.wxCache.data[`${vd.lat.toFixed(3)},${vd.lng.toFixed(3)}|${b.g.date}`];
                    if (wx) b.wx = { ...weatherFactor(wx, false), label: vd.label };
                }
            }
        }

        APP.lastSlate = { season, week, bundles, allTeams: fixtures.flatMap(g => [g.away, g.home]) };
        rerenderSlate();
        setStatus('#startStatus', `Projected week ${week} of ${season} · trained through prior games (${APP.loadedRange[0]}–${APP.loadedRange[1]} data)`);
    } catch (e) {
        console.error(e);
        setStatus('#startStatus', 'Error: ' + e.message, 'err');
    } finally {
        btn.disabled = false;
    }
}

function venueInfo(g) {
    const iv = INTL_VENUES[g.stadium];
    if (iv) return iv;
    if (g.loc === 'Neutral') return null;             // unknown neutral site: skip weather
    const t = TEAMS[g.home];
    return t ? { lat: t.lat, lng: t.lng, dome: indoorGame(g, t), label: '' } : null;
}
function indoorGame(g, t) {
    if (g.roof === 'dome' || g.roof === 'closed') return true;
    if (g.roof === 'outdoors' || g.roof === 'open') return false;
    return !!(t && t.dome);
}

function rerenderSlate() {
    if (!APP.lastSlate) return;
    const cfg = currentCfg();
    const { season, week, bundles } = APP.lastSlate;
    for (const b of bundles) {
        const f = b.wx ? b.wx.f : 1;
        const prEff = f === 1 ? b.prRaw : { ...b.prRaw, expOpp: b.prRaw.expOpp * f };
        Object.assign(b, monteCarlo(prEff, cfg, CFG.MODEL.sims,
            (season * 100 + week) * 7919 + b.defT.charCodeAt(0)));
        b.actual = b.raw ? actualDefPoints(b.raw, cfg) : null;
    }
    bundles.sort((a, b) => b.ev - a.ev);

    const tr = APP.lastTracker;
    const lgPf = tr.lgMean('pf') || 22;
    const powers = new Map();
    for (const team of APP.lastSlate.allTeams) {
        const v = tr.teamStat(team, 'pf', '', CFG.MODEL.K, CFG.MODEL.Kv);
        if (v != null) powers.set(team, v / lgPf);
    }
    const sortedPow = [...powers.entries()].sort((a, b) => b[1] - a[1]);
    const powRank = new Map(sortedPow.map(([t], i) => [t, i + 1]));
    const nPow = sortedPow.length || 30;

    // median/pool context
    const med = (() => { const e = bundles.map(b => b.ev).sort((a, b) => a - b);
        return e.length % 2 ? e[(e.length - 1) / 2] : (e[e.length / 2 - 1] + e[e.length / 2]) / 2; })();

    const ownedBy = ownershipMap();
    const tbody = $('#startTable tbody');
    const done = bundles.every(b => b.played);
    $('#thActual').hidden = !done;
    let html = '';
    bundles.forEach((b, i) => {
        const rk = powRank.get(b.offT);
        const pw = powers.get(b.offT);
        const offLbl = rk == null ? '—'
            : `<a href="#" class="opplog" data-team="${b.offT}" title="Click: points defenses have scored vs ${b.offT} this season">#${rk} ${pw >= 1.12 ? 'elite' : pw >= 1.03 ? 'strong' : pw <= .9 ? 'weak' : 'avg'}</a>`;
        const chips = [];
        if (b.venue === 'H') chips.push('<span class="chip">Home</span>');
        if (b.venue === 'N') chips.push(`<span class="chip neutral">${esc(INTL_VENUES[b.g.stadium]?.label || 'Neutral site')}</span>`);
        if (b.wx && b.wx.f < 1) chips.push(`<span class="chip good" title="expected opponent scoring reduced ${(1 - b.wx.f) * 100 | 0}%">🌬️ ${fmt(b.wx.wind, 0)} mph${b.wx.rain >= 5 ? ' 🌧️' : ''}</span>`);
        if (indoorGame(b.g, TEAMS[b.g.home])) chips.push('<span class="chip">Dome</span>');
        if (b.played) chips.push('<span class="chip dim">final</span>');
        let own = '';
        if (ownedBy.has(b.defT)) {
            const owners = ownedBy.get(b.defT);
            own = ` <span class="chip warn" title="${esc(owners.join(', '))}">owned ×${owners.length}</span>`;
        } else if (APP.leagueCtx) own = ' <span class="chip good">FA</span>';
        const deltaCls = b.actual === null ? '' : b.actual >= med ? 'pos' : 'neg';
        const q = i / Math.max(1, bundles.length - 1);
        const rowCls = q < .18 ? 'row-hot' : q > .82 ? 'row-cold' : '';
        html += `<tr class="${rowCls}">
          <td>${i + 1}</td>
          <td><b>${b.defT}</b> <span class="dim">${esc(TEAMS[b.defT]?.name || '')}</span>${own}</td>
          <td>${b.venue === 'H' ? 'vs' : b.venue === 'A' ? '@' : '*'} <b>${b.offT}</b></td>
          <td class="num strong">${fmt(b.ev)}</td>
          <td class="num dim">${fmt(b.p10, 0)}–${fmt(b.p90, 0)}</td>
          <td class="num">${(b.boom * 100).toFixed(0)}%</td>
          <td>${offLbl}</td>
          <td>${chips.join(' ') || '<span class="dim">—</span>'}</td>
          <td class="num ${deltaCls}" ${b.actual === null ? 'hidden' : ''}>${b.actual === null ? '' : fmt(b.actual)}</td></tr>`;
    });
    tbody.innerHTML = html;

    // banner: byes + context
    const playing = new Set(APP.lastSlate.allTeams);
    const byes = [...(APP.lastTracker?.teams?.keys() || [])].filter(t => !playing.has(t) && TEAMS[t]);
    const banners = [];
    if (byes.length) banners.push(`<div class="banner">Bye (unstartable): <b>${byes.join(', ')}</b></div>`);
    banners.push(`<div class="banner stat">Median projected streamer: <b>${fmt(med)}</b> pts ·
        your model edge starts where most leaguers lazily start</div>`);
    if (done) banners.push(`<div class="banner good-banner">Completed week — Actual column shows how the board played out.</div>`);
    $('#startBanner').innerHTML = banners.join('');
    $('#startBanner').hidden = false;

    renderFaStrip(cfg);
}

/* Best-addable strip when a league is linked. */
function renderFaStrip(cfg) {
    const strip = $('#faStrip');
    if (!APP.leagueCtx || !$('#chkUseLeagueScoring')?.checked) { strip.hidden = true; return; }
    const { bundles } = APP.lastSlate;
    const faSet = APP.leagueCtx.faDefs;
    if (!faSet) { strip.hidden = true; return; }
    const fas = bundles.filter(b => faSet.has(b.defT)).slice(0, 4);
    const ownedTop = bundles.find(b => !faSet.has(b.defT));
    if (!fas.length) { strip.hidden = true; return; }
    strip.innerHTML = `<h4>Addable from waivers / free agency</h4>` +
        fas.map(b => `<a class="fa-chip" title="${esc(teamLabel(b.defT))}">${b.defT} · ${fmt(b.ev)} pts ${b.venue === 'A' ? '@' : b.venue === 'N' ? '*' : 'vs'} ${b.offT}</a>`).join('') +
        (ownedTop ? `<span class="hint">Best owned DEF on the board: <b>${ownedTop.defT}</b> (${fmt(ownedTop.ev)}) — only relevant if you actually start it 😄</span>` : '');
    strip.hidden = false;
}

function ownershipMap() {
    if (!APP.leagueCtx?.defsByOwner) return new Map();
    const m = new Map();
    for (const [def, owners] of APP.leagueCtx.defsByOwner)
        if (owners.length) m.set(def, owners);
    return m;
}

/* ---------------- opponent defense-score log (click Opponent cell) ---------------- */
function buildOppLog(team, season, cfg) {
    const idx = new Map(APP.recsFull.map(r => [`${r.season}:${r.week}:${r.team}`, r]));
    const games = APP.recsFull.filter(r => r.season === season && r.team === team && !r.post)
        .sort((a, b) => a.week - b.week);
    if (!games.length) return null;
    // league avg D/ST that season under this scoring for context coloring
    const seasonAll = APP.recsFull.filter(r => r.season === season && !r.post);
    const lgAvg = meanArr(seasonAll.map(r => actualDefPoints(r, cfg)));
    const rows = [];
    for (const m of games) {
        const oppDef = idx.get(`${season}:${m.week}:${m.opp}`);
        if (!oppDef) continue;
        rows.push({ week: m.week, venue: m.venue, opp: m.opp,
            pts: actualDefPoints(oppDef, cfg), pa: m.pa });
    }
    const vals = rows.map(r => r.pts);
    const boomN = vals.filter(v => v >= CFG.BOOM_PTS).length;
    const summary = { n: vals.length, avg: meanArr(vals), max: Math.max(...vals),
        boom: boomN, bust: vals.filter(v => v <= 3).length, lgAvg };
    return { rows, summary };
}
function meanArr(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

function renderOppLog(team, season, cfg) {
    const log = buildOppLog(team, season, cfg);
    if (!log) return `<div class="logbox">No completed games yet for ${team} in ${season}.</div>`;
    const s = log.summary;
    const chips = [`<b>${s.n} games</b>`, `D/STs avg <b>${fmt(s.avg)}</b> vs league ${fmt(s.lgAvg)}`,
        `${s.boom} boom (≥${CFG.BOOM_PTS})`, `${s.bust} bust (≤3)`];
    const cells = log.rows.map(r => {
        const cls = r.pts >= CFG.BOOM_PTS ? 'pos' : r.pts <= 3 ? 'neg' : '';
        return `<span class="log-cell" title="wk${r.week} ${r.venue === 'A' ? 'at' : r.venue === 'N' ? '*' : 'vs'} ${r.opp}, opp scored ${r.pa}">
                <i>w${r.week}</i><u>${r.opp}</u><b class="${cls}">${fmt(r.pts, 0)}</b></span>`;
    }).join('');
    const lean = s.avg > s.lgAvg * 1.08 ? '<span class="chip good">gives up extra pts to Ds</span>'
        : s.avg < s.lgAvg * .92 ? '<span class="chip bad">holds opposing Ds quiet</span>' : '<span class="chip">league-average</span>';
    return `<div class="logbox">
      <div class="log-head"><b>${esc(teamLabel(team))}</b> offense — fantasy points given up to opposing defenses, ${season} ${lean}</div>
      <div class="log-sum">${chips.join(' · ')}</div>
      <div class="log-cells">${cells}</div>
      <p class="fnote">Green ≥ ${CFG.BOOM_PTS} pts (boom-week material) · red ≤ 3 pts. Hover any game for venue & final score.</p></div>`;
}

function attachOppLogClicks() {
    $('#startTable').addEventListener('click', e => {
        const a = e.target.closest('a.opplog');
        if (!a) return;
        e.preventDefault();
        const tr = a.closest('tr');
        const existing = tr.nextElementSibling;
        if (existing?.classList.contains('detail-row')) { existing.remove(); return; }
        document.querySelectorAll('#startTable .detail-row').forEach(x => x.remove());
        const season = APP.lastSlate?.season || APP.currentSeason;
        const det = document.createElement('tr');
        det.className = 'detail-row';
        det.innerHTML = `<td colspan="10">${renderOppLog(a.dataset.team, season, currentCfg())}</td>`;
        tr.after(det);
    });
}

/* ---------------- history explorer ---------------- */
const HIST_COLS = [
    ['season', 'Season', v => v], ['team', 'Team', v => v],
    ['gp', 'GP', v => v], ['avg', 'Avg', v => fmt(v)], ['pts', 'Pts', v => fmt(v)],
    ['hAvg', 'Home', v => fmt(v)], ['aAvg', 'Away', v => fmt(v)],
    ['best', 'Best wk', v => fmt(v)], ['top5', 'Top5wk', v => v], ['top10', 'Top10wk', v => v],
    ['to', 'TO/g', v => fmt(v, 2)], ['sk', 'Sack/g', v => fmt(v, 1)], ['td', 'D/ST TDs', v => v],
];
let histSort = { key: 'season', dir: -1 };
const histSelected = new Set();

async function loadHistory() {
    const startSel = $('#selHistStart');
    APP.histStart = +startSel.value;
    const end = APP.currentSeason || 2026;
    try {
        setStatus('#histStatus', 'Loading…');
        await ensureData(end, APP.histStart);
        const cfg = currentCfg();
        const { rows, leagueAvg } = aggregateHistory(cfg);
        renderHistory(rows, leagueAvg);
        setStatus('#histStatus', `${rows.length} team-seasons from ${APP.loadedRange[0]}–${APP.loadedRange[1]}`);
    } catch (e) {
        console.error(e);
        setStatus('#histStatus', 'Error: ' + e.message, 'err');
    }
}
function aggregateHistory(cfg) {
    // week pools for top-K thresholds
    const pools = new Map();
    const withPts = APP.recs.map(r => ({ r, pts: actualDefPoints(r, cfg) }));
    for (const { r, pts } of withPts) {
        const k = r.season + ':' + r.week;
        (pools.get(k) || pools.set(k, []).get(k)).push(pts);
    }
    const topK = new Map();
    for (const [k, arr] of pools) {
        const s = [...arr].sort((a, b) => b - a);
        topK.set(k, { k5: s[Math.min(4, s.length - 1)], k10: s[Math.min(9, s.length - 1)] });
    }
    const agg = new Map();
    for (const { r, pts } of withPts) {
        const key = r.season + '|' + r.team;
        let a = agg.get(key);
        if (!a) agg.set(key, a = { season: r.season, team: r.team, gp: 0, pts: 0, hp: 0, hn: 0, ap: 0, an: 0, best: -99, top5: 0, top10: 0, to: 0, sk: 0, td: 0 });
        const t = topK.get(r.season + ':' + r.week);
        a.gp++; a.pts += pts; a.best = Math.max(a.best, pts);
        if (r.venue === 'H') { a.hp += pts; a.hn++; } else if (r.venue === 'A') { a.ap += pts; a.an++; }
        if (pts >= t.k5) a.top5++; if (pts >= t.k10) a.top10++;
        a.to += r.d_int + r.d_fr; a.sk += r.d_sacks; a.td += r.d_td + r.st_td;
    }
    const rows = [...agg.values()].map(a => ({
        ...a, avg: a.pts / a.gp, hAvg: a.hn ? a.hp / a.hn : NaN, aAvg: a.an ? a.ap / a.an : NaN,
        to: a.to / a.gp, sk: a.sk / a.gp,
    })).sort((a, b) => b.season - a.season || b.avg - a.avg);
    const leagueAvg = new Map();
    for (const s of rows) leagueAvg.set(s.season, (leagueAvg.get(s.season) || 0) + s.avg);
    for (const [s, v] of leagueAvg) leagueAvg.set(s, v / rows.filter(r => r.season === s).length);
    return { rows, leagueAvg };
}
function renderHistory(rows, leagueAvg) {
    const head = HIST_COLS.map(([k, l]) =>
        `<th class="sortable ${histSort.key === k ? 'sorted' : ''}" data-k="${k}">${l}${histSort.key === k ? (histSort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('');
    $('#histTable thead').innerHTML = '<tr>' + head + '</tr>';
    $$('#histTable th.sortable').forEach(th => th.onclick = () => {
        const k = th.dataset.k;
        histSort = { key: k, dir: histSort.key === k ? -histSort.dir : (k === 'team' || k === 'season' ? -1 : -1) };
        loadHistoryRerenderOnly(rows, leagueAvg);
    });
    fillHistRows(rows);
    drawHistChart(leagueAvg);
}
function loadHistoryRerenderOnly(rows, leagueAvg) {
    const sorted = [...rows].sort((a, b) => {
        const { key, dir } = histSort;
        const x = a[key], y = b[key];
        return (typeof x === 'string' ? String(x).localeCompare(y) : (x - y)) * dir;
    });
    fillHistRows(sorted);
    renderHistoryHeadOnly(rows, leagueAvg, sorted);
}
function renderHistoryHeadOnly(rows, la, sorted) { // re-sort headers w/o rebinding messiness
    $('#histTable thead').innerHTML = '<tr>' + HIST_COLS.map(([k, l]) =>
        `<th class="sortable ${histSort.key === k ? 'sorted' : ''}" data-k="${k}">${l}${histSort.key === k ? (histSort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('') + '</tr>';
    $$('#histTable th.sortable').forEach(th => th.onclick = () => {
        histSort = { key: th.dataset.k, dir: histSort.key === th.dataset.k ? -histSort.dir : -1 };
        loadHistoryRerenderOnly(rows, la);
    });
}
function fillHistRows(rows) {
    $('#histTable tbody').innerHTML = rows.slice(0, 800).map(r => {
        const sel = histSelected.has(r.team) ? ' class="picked"' : '';
        return `<tr${sel} data-team="${r.team}">` + HIST_COLS.map(([k, , f]) =>
            `<td class="${k === 'season' || k === 'team' ? '' : 'num'}">${f(r[k])}</td>`).join('') + '</tr>';
    }).join('');
    $$('#histTable tbody tr').forEach(tr => tr.onclick = () => {
        const t = tr.dataset.team;
        histSelected.has(t) ? histSelected.delete(t) : (histSelected.size < 5 && histSelected.add(t));
        tr.classList.toggle('picked');
        drawHistChart(null);
    });
}

const CHART_COLORS = ['#fbbf24', '#38bdf8', '#4ade80', '#f472b6', '#a78bfa'];
function drawHistChart(leagueAvg) {
    const cv = $('#histChart'), dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || cv.parentElement.clientWidth, H = 260;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    if (!APP.recs?.length) return;
    const cfg = currentCfg();
    const series = {}; // team -> {season:avg}
    for (const t of histSelected) series[t] = {};
    const lg = {};
    for (const r of APP.recs) {
        const p = actualDefPoints(r, cfg);
        if (histSelected.has(r.team)) (series[r.team][r.season] ||= [0, 0], series[r.team][r.season][0] += p, series[r.team][r.season][1]++);
        (lg[r.season] ||= [0, 0], lg[r.season][0] += p, lg[r.season][1]++);
    }
    const seasons = Object.keys(lg).map(Number).sort((a, b) => a - b);
    const vals = Object.values(lg).map(v => v[0] / v[1]).concat(Object.values(series).flatMap(o => Object.values(o).map(v => v[0] / v[1])));
    const vmax = Math.max(...vals) * 1.12, vmin = 0;
    const X = i => 42 + i * ((W - 60) / Math.max(1, seasons.length - 1));
    const Y = v => H - 26 - (v - vmin) / (vmax - vmin) * (H - 40);
    ctx.strokeStyle = 'rgba(148,163,184,.15)'; ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui';
    for (let i = 0; i <= 4; i++) {
        const v = vmin + (vmax - vmin) * i / 4, y = Y(v);
        ctx.beginPath(); ctx.moveTo(42, y); ctx.lineTo(W - 14, y); ctx.stroke();
        ctx.fillText(fmt(v, 1), 8, y + 4);
    }
    ctx.textAlign = 'center';
    const step = Math.ceil(seasons.length / 10);
    seasons.forEach((s, i) => { if (i % step === 0) ctx.fillText(s, X(i), H - 8); });
    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#64748b'; ctx.beginPath();
    seasons.forEach((s, i) => { const [sum, n] = lg[s]; const y = Y(sum / n); i ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y); });
    ctx.stroke(); ctx.setLineDash([]);
    let ci = 0;
    const legend = [];
    for (const t of histSelected) {
        const col = CHART_COLORS[ci++ % CHART_COLORS.length];
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
        let started = false;
        seasons.forEach((s, i) => {
            if (!series[t][s]) return;
            const [sum, n] = series[t][s], y = Y(sum / n);
            started ? ctx.lineTo(X(i), y) : (ctx.moveTo(X(i), y), started = true);
        });
        ctx.stroke(); ctx.lineWidth = 1;
        legend.push(`<span class="lg-item"><i style="background:${col}"></i>${t}</span>`);
    }
    legend.unshift('<span class="lg-item"><i style="background:#64748b;height:2px;border-radius:0"></i>League average</span>');
    $('#chartLegend').innerHTML = legend.join('');
    $('#chartHint').textContent = histSelected.size ? '' : 'pick up to 5 defenses in the table above';
}

/* ---------------- backtest tab ---------------- */
async function doBacktest() {
    const from = +$('#selBtStart').value;
    try {
        setStatus('#btStatus', 'Loading data for backtest…');
        await ensureData(APP.currentSeason || 2026, Math.max(CFG.HISTORY_MIN_SEASON, from - 4));
        setStatus('#btStatus', 'Simulating every week… this can take a few seconds.');
        const cfg = currentCfg();
        const t0 = performance.now();
        const res = await runBacktest({ recs: APP.recs, events: APP.events, cfg,
            firstSeason: from, sims: CFG.MODEL.btSims,
            onProgress: m => setStatus('#btStatus', m) });
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        setStatus('#btStatus', `Done in ${secs}s · ${res.weeks} evaluated weeks.`);
        $('#btResults').hidden = false;
        $('#btCards').innerHTML = card('Spearman ρ', fmt(res.rho, 3), 'proj-vs-actual rank correlation per week') +
            card('Top-1 pick avg', fmt(res.top1), `pts vs median streamer ${fmt(res.median)}`) +
            card('Top-3 picks avg', fmt(res.top3), `lift over median: <b>+${fmt(res.lift3)}</b> pts`) +
            card('Top-1 beats median', (res.hitTop1 * 100).toFixed(0) + '%', 'how often the #1 recommendation outscored the median starter');
        $('#btYears thead').innerHTML = '<tr><th>Season</th><th>Weeks</th><th>ρ</th><th>Top3 lift vs median</th></tr>';
        $('#btYears tbody').innerHTML = Object.keys(res.perYear).sort().map(y => {
            const p = res.perYear[y];
            return `<tr><td>${y}</td><td class="num">${p.weeks}</td><td class="num">${fmt(p.rho, 3)}</td>
                    <td class="num ${p.lift > 0 ? 'pos' : 'neg'}">${p.lift > 0 ? '+' : ''}${fmt(p.lift)}</td></tr>`;
        }).join('');
        $('#btBench').innerHTML = `
            <table class="data-table dense"><tbody>
              <tr><td><b>This model (all factors)</b></td><td class="num strong">${fmt(res.top3)}</td><td>avg pts of weekly top-3 recommendations</td></tr>
              <tr><td>Matchup-only ablation (fewest expected pts allowed, ignoring sacks/takeaways/home)</td><td class="num">${fmt(res.naiveMatchupTop3)}</td><td>what a single-number "face worst offense" board earns</td></tr>
              <tr><td>Blindly start any home defense</td><td class="num">${fmt(res.blindHomeAvg)}</td><td>the lazy-starter benchmark</td></tr>
              <tr><td>Median startable defense that week</td><td class="num">${fmt(res.median)}</td><td>roughly what a waiver-level add scores</td></tr>
              <tr><td>Random startable defense</td><td class="num">${fmt(res.pool)}</td><td>pool average (+${fmt(res.randVsMedian)} vs median)</td></tr>
            </tbody></table>
            <p class="fnote">Backtest retrains strictly walk-forward (only games completed before each evaluated week),
            so these numbers reflect honest out-of-sample behavior on data since ${from}.</p>`;
        $('#btDetails thead').innerHTML = '<tr><th>Season</th><th>Wk</th><th>Top-1 REC</th><th class="num">Proj</th><th class="num">Actual</th><th class="num">Median</th><th class="num">Top3 avg</th></tr>';
        $('#btDetails tbody').innerHTML = res.details.slice(0, 120).map(d =>
            `<tr><td>${d.season}</td><td>${d.week}</td><td><b>${d.pick}</b></td>
             <td class="num">${fmt(d.ev)}</td>
             <td class="num ${d.actual >= d.med ? 'pos' : 'neg'}">${fmt(d.actual)}</td>
             <td class="num dim">${fmt(d.med)}</td><td class="num dim">${d.top3}</td></tr>`).join('');
    } catch (e) {
        console.error(e);
        setStatus('#btStatus', 'Error: ' + e.message, 'err');
    }
}
function card(label, big, sub) {
    return `<div class="metric-card"><div class="m-label">${label}</div><div class="m-big">${big}</div><div class="m-sub">${sub}</div></div>`;
}

/* ---------------- league integration ---------------- */
async function findLeagues() {
    const uname = $('#inpUser').value.trim();
    if (!uname) return setStatus('#leagueStatus', 'Enter a username.', 'warn');
    setStatus('#leagueStatus', 'Looking up ' + uname + '…');
    try {
        const user = await userObj(uname);
        if (!user?.user_id) throw new Error('User not found');
        const season = APP.currentSeason || new Date().getFullYear();
        const lists = await Promise.all([season, season - 1, season - 2, season - 3, season - 4, season - 5]
            .map(s => userLeagues(user.user_id, s)));
        const leagues = lists.flat().filter(l => l.sport === 'nfl');
        if (!leagues.length) throw new Error('No NFL leagues found for recent seasons');
        APP.leagueUser = user;
        fillSelect($('#selLeague'), leagues.map(l => ({ v: l.league_id,
            l: `[${l.season}] ${l.name} (${l.status})` })));
        $('#leagueBody').hidden = false;
        setStatus('#leagueStatus', `${user.display_name || user.username}: ${leagues.length} league(s). Pick one.`);
        await chooseLeague();
    } catch (e) {
        setStatus('#leagueStatus', e.message, 'err');
        $('#leagueBody').hidden = true;
    }
}
async function chooseLeague() {
    const lid = $('#selLeague').value;
    if (!lid) return;
    setStatus('#leagueStatus', 'Loading league…');
    try {
        const [detail, rosters, users] = await Promise.all([
            leagueDetail(lid), leagueRosters(lid), sleeper(`/league/${lid}/users`)]);
        const nameOf = new Map(users.map(u => [u.user_id, u.display_name || u.username]));
        const defsByOwner = new Map();
        const ownersWithDef = new Set();
        for (const t of Object.keys(TEAMS)) defsByOwner.set(t, []);
        for (const ros of rosters) {
            const owner = nameOf.get(ros.owner_id) || ('roster ' + ros.roster_id);
            const d = (ros.players || []).find(p => TEAMS[p] && !/^\d+$/.test(p));
            if (d) {
                if (!defsByOwner.has(d)) defsByOwner.set(d, []);
                defsByOwner.get(d).push(owner);
                ownersWithDef.add(owner);
            }
        }
        const faDefs = new Set([...defsByOwner.keys()].filter(t => !defsByOwner.get(t).length));
        APP.leagueCtx = { league: detail, scoring: detail.scoring_settings || {},
            rosters, users, defsByOwner, faDefs, nameOf };
        refreshScoringOptions();
        $('#selScoring').value = $('#chkUseLeagueScoring').checked ? 'league' : $('#selScoring').value;
        renderLeagueSummary();
        setStatus('#leagueStatus', 'League linked — ownership badges now show on the Start tab.');
        if (APP.lastSlate) rerenderSlate();
    } catch (e) {
        setStatus('#leagueStatus', 'Error: ' + e.message, 'err');
    }
}
function renderLeagueSummary() {
    const { league, scoring, defsByOwner } = APP.leagueCtx;
    const cfg = scoringFromSleeperSettings(scoring, $('#chkSacks').checked);
    const tiersTxt = cfg.tiers.map(([lb, p]) => p).join(' / ');
    $('#leagueSummary').innerHTML = `
      <h3 class="card-title">${esc(league.name)} · ${league.season}</h3>
      <p>${league.total_rosters} teams · scoring applied to models right now:</p>
      <table class="data-table dense"><tbody>
        <tr><th>Allowed-tier pts</th><td>${tiersTxt}</td></tr>
        <tr><th>Sack / INT / FF / FR</th><td>${cfg.sack} / ${cfg.int} / ${cfg.ff} / ${cfg.fr}</td></tr>
        <tr><th>D-TD / ST-TD / Safety / Block</th><td>${cfg.def_td} / ${cfg.st_td} / ${cfg.safety} / ${cfg.blk_kick}</td></tr>
      </tbody></table>
      <p class="hint">Toggle “sacks count” on the Start tab if your league doesn't score sacks for D/ST.</p>`;
    $('#ownershipGrid').innerHTML = [...defsByOwner.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([t, owners]) =>
            `<div class="own-cell ${owners.length ? '' : 'free'}"><b>${t}</b>
             <span>${owners.length ? esc(owners.join(', ')) : 'FREE AGENT'}</span></div>`).join('');
}

/* ---------------- boot ---------------- */
async function boot() {
    fillSelect($('#selSeason'), seasonOptions(), APP.currentSeason);
    fillSelect($('#selHistStart'), seasonOptions().filter(o => o.v <= (APP.currentSeason || 2026)), APP.histStart);
    fillSelect($('#selBtStart'), seasonOptions().filter(o => o.v >= CFG.HISTORY_MIN_SEASON + 4 && o.v <= (APP.currentSeason || 2026) - 1), 2020);
    refreshScoringOptions();
    $('#chkSacks').addEventListener('change', () => { rerenderSlate(); });
    $('#selScoring').addEventListener('change', () => { rerenderSlate(); });
    $('#chkWeather').addEventListener('change', () => analyzeWeek());
    $('#btnAnalyze').addEventListener('click', () => analyzeWeek());
    attachOppLogClicks();
    $('#selSeason').addEventListener('change', () => { refreshWeekOptions().then(() => analyzeWeek()); });
    $('#selWeek').addEventListener('change', () => analyzeWeek());
    $('#btnHistory').addEventListener('click', () => withProgress('#histProgress', loadHistory()));
    $('#selHistStart').addEventListener('change', () => withProgress('#histProgress', loadHistory()));
    $('#btnBacktest').addEventListener('click', () => withProgress('#btProgress', doBacktest()));
    $('#btnLeague').addEventListener('click', findLeagues);
    $('#inpUser').addEventListener('keydown', e => { if (e.key === 'Enter') findLeagues(); });
    $('#selLeague').addEventListener('change', chooseLeague);
    $('#chkUseLeagueScoring').addEventListener('change', e => {
        if (e.target.checked && APP.leagueCtx) $('#selScoring').value = 'league';
        else if (APP.lastSlate) $('#selScoring').value = 'sleeper';
        rerenderSlate();
    });
    $('#chkSacks').addEventListener('change', renderLeagueSummaryIfReady);

    setStatus('#startStatus', 'Fetching current NFL state…');
    let st = null;
    try { st = await sleeperState(); } catch (e) { /* offline: stay on defaults */ }
    APP.currentSeason = st ? +st.season : new Date().getFullYear();
    fillSelect($('#selSeason'), seasonOptions(), APP.currentSeason);
    fillSelect($('#selHistStart'), seasonOptions().filter(o => o.v <= APP.currentSeason), APP.histStart);
    fillSelect($('#selBtStart'), seasonOptions().filter(o => o.v >= CFG.HISTORY_MIN_SEASON + 4 && o.v <= APP.currentSeason - 1), 2020);
    await refreshWeekOptions();
    const meta = await loadMeta();
    if (meta?.updated_utc) {
        const el = $('#dataFresh');
        if (el) el.textContent = ' · data refreshed ' + meta.updated_utc.slice(0, 16).replace('T', ' ') + ' UTC';
    }

    // auto-target: earliest week of current season with unfinished games
    try {
        await ensureYear(APP.currentSeason);
        const rows = gamesForSeason(APP.currentSeason);
        const fut = rows.filter(g => g.as === null && g.date >= APP.todayISO)
            .sort((a, b) => a.date < b.date ? -1 : 1)[0];
        const target = fut || rows.sort((a, b) => a.date > b.date ? -1 : 1)[0];
        if (target) {
            $('#selSeason').value = String(target.season);
            await refreshWeekOptions();
            $('#selWeek').value = String(target.week);
        }
        await analyzeWeek(true);
    } catch (e) {
        console.error(e);
        setStatus('#startStatus', 'Could not preload schedule: ' + e.message + ' — try Analyze Week.', 'err');
    }
}
function renderLeagueSummaryIfReady() { if (APP.leagueCtx) renderLeagueSummary(); }

document.addEventListener('DOMContentLoaded', boot);
