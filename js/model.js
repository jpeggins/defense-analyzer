/* ================================================================
   D/ST Streamer — rating engine + Monte-Carlo projection + backtester.
   Port of the validated Python prototype (see README for methodology
   and backtest results). Time-weighted, shrunk, venue-split team
   ratings trained strictly on games before the target week.
   ================================================================ */

/* ---- seeded RNG (mulberry32) + gaussian ---- */
function makeRng(seed) {
    let a = seed >>> 0;
    const rnd = () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    return function gauss() {
        if (spare !== null) { const s = spare; spare = null; return s; }
        let u, v, s;
        do { u = rnd() * 2 - 1; v = rnd() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
        const m = Math.sqrt(-2 * Math.log(s) / s);
        spare = v * m;
        return u * m;
    };
}
function mulberry32unit() {
    let a = 1234567 >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const FEATS = ['pf', 'pa', 'sk', 'to_int', 'to_ff', 'to_fr', 'tdf', 'blk', 'sf_sack', 'off_to'];
const LN2 = Math.log(2);

function featFromRec(r) {
    return {
        pf: r.pf, pa: r.pa, sk: r.d_sacks, to_int: r.d_int, to_ff: r.d_ff,
        to_fr: r.d_fr, tdf: r.d_td + r.st_td, blk: r.d_blk,
        sf_sack: r.sackSuf, off_to: r.give,
    };
}

const MONTH_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function dateToWeeks(datestr) {
    const p = datestr.split('-');
    return (parseInt(p[0]) * 367 + MONTH_DAYS[parseInt(p[1]) - 1] + parseInt(p[2])) / 7.0;
}

/* Chronological week-events for the training walk (regular season games). */
function buildWeekEvents(recs) {
    const map = new Map();
    for (const r of recs) {
        const k = r.season * 100 + r.week;
        let e = map.get(k);
        if (!e) map.set(k, e = { season: r.season, week: r.week, t: Infinity, recs: [] });
        e.recs.push(r);
        const t = dateToWeeks(r.date);
        if (t < e.t) e.t = t;
    }
    return [...map.values()].sort((a, b) => a.t - b.t);
}

class Tracker {
    constructor(hlWeeks) {
        this.hl = hlWeeks;
        this.t = 0;
        this.teams = new Map();     // team -> Map("feat|venue" -> [wsum, xsum])
        this.lg = new Map();        // feat -> [wsum, xsum]
        this.lgVenuePts = { H: [0, 0], A: [0, 0] };
    }
    advance(dt) {
        if (dt <= 0) return;
        const f = Math.exp(-dt * LN2 / this.hl);
        for (const d of this.teams.values())
            for (const c of d.values()) { c[0] *= f; c[1] *= f; }
        for (const c of this.lg.values()) { c[0] *= f; c[1] *= f; }
        for (const c of [this.lgVenuePts.H, this.lgVenuePts.A]) { c[0] *= f; c[1] *= f; }
        this.t += dt;
    }
    add(rec) {
        const ft = featFromRec(rec), v = rec.venue;
        let d = this.teams.get(rec.team);
        if (!d) this.teams.set(rec.team, d = new Map());
        for (const k of FEATS) {
            const x = ft[k];
            let c = d.get(k); if (!c) d.set(k, c = [0, 0]);
            c[0]++; c[1] += x;
            if (v === 'H' || v === 'A') {
                const vk = k + '|' + v;
                let cv = d.get(vk); if (!cv) d.set(vk, cv = [0, 0]);
                cv[0]++; cv[1] += x;
            }
            let L = this.lg.get(k); if (!L) this.lg.set(k, L = [0, 0]);
            L[0]++; L[1] += x;
        }
        if (v === 'H' || v === 'A') {
            const vp = this.lgVenuePts[v]; vp[0]++; vp[1] += ft.pf;
        }
    }
    lgMean(feat) {
        const L = this.lg.get(feat);
        return L && L[0] > 0 ? L[1] / L[0] : 0;
    }
    venueAvgPts(venue) {
        const q = this.lgVenuePts.H, a = this.lgVenuePts.A;
        if (venue === 'H' && q[0] > 60) return q[1] / q[0];
        if (venue === 'A' && a[0] > 60) return a[1] / a[0];
        const tot = q[0] + a[0];
        return tot ? (q[1] + a[1]) / tot : 22.0;
    }
    /* Shrunk mean stat for team (optionally venue split), in raw per-game units. */
    teamStat(team, feat, venue, K, Kv) {
        const d = this.teams.get(team);
        if (!d) return null;
        const L = this.lg.get(feat) || [0, 0];
        const lgm = L[0] > 0 ? L[1] / L[0] : 0;
        const o = d.get(feat) || [0, 0];
        const over = (o[1] + K * lgm) / (o[0] + K);
        if (venue === 'H' || venue === 'A') {
            const v = d.get(feat + '|' + venue);
            if (v) return (v[1] + Kv * over) / (v[0] + Kv);
        }
        return over;
    }
}

/* Walk the event stream, adding every event strictly before targetKey. */
function trainTracker(events, targetSeason, targetWeek, fromIdx = 0) {
    const tr = new Tracker(CFG.MODEL.hlWeeks);
    if (!events.length) return { tracker: tr, idx: 0 };
    tr.t = events[0].t;
    let i = fromIdx;
    for (; i < events.length; i++) {
        const e = events[i];
        if (e.season > targetSeason || (e.season === targetSeason && e.week >= targetWeek)) break;
        tr.advance(e.t - tr.t);
        for (const r of e.recs) tr.add(r);
    }
    return { tracker: tr, idx: i };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/* Build expectancy parameters for defT (at venue vs offense offT). */
function predictParams(tr, K, Kv, defT, offT, venue) {
    if (tr.teamStat(defT, 'pa', '', K, Kv) === null ||
        tr.teamStat(offT, 'pf', '', K, Kv) === null) return null;
    const M = CFG.MODEL.caps;
    const oV = venue === 'H' ? 'A' : venue === 'A' ? 'H' : '';
    const dv = (venue === 'H' || venue === 'A') ? venue : '';
    const tsd = f => tr.teamStat(defT, f, dv, K, Kv);
    const tso = f => tr.teamStat(offT, f, oV, K, Kv);
    const mu = tr.venueAvgPts(venue === 'N' ? '' : venue);
    const lgPa = tr.lgMean('pa') || 22, lgPf = tr.lgMean('pf') || 22;
    const attR = clamp(tso('pf') / lgPf, ...M.att);
    const defR = clamp(tsd('pa') / lgPa, ...M.att);
    const expOpp = mu * attR * defR;

    const lgSK = tr.lgMean('sk') || 2.2, lgInt = tr.lgMean('to_int') || 1.1;
    const lgFF = tr.lgMean('to_ff') || 1.4, lgFr = tr.lgMean('to_fr') || 1.0;
    const lgSuf = tr.lgMean('sf_sack') || 2.3, lgGive = tr.lgMean('off_to') || 1.7;
    const lgTdf = tr.lgMean('tdf') || 0.06, lgBlk = tr.lgMean('blk') || 0.05;

    const dSk = clamp(tsd('sk') / lgSK, ...M.stat);
    const dInt = clamp(tsd('to_int') / lgInt, ...M.stat);
    const dFf = clamp(tsd('to_ff') / lgFF, ...M.stat);
    const gGive = clamp(tso('off_to') / lgGive, ...M.give);
    const gSack = clamp(tso('sf_sack') / lgSuf, ...M.give);
    const tdfR = clamp(tr.teamStat(defT, 'tdf', '', K, Kv) / lgTdf, ...M.stat);
    const blkR = clamp(tr.teamStat(defT, 'blk', '', K, Kv) / lgBlk, ...M.stat);
    return {
        expOpp, expSk: lgSK * dSk * gSack, expInt: lgInt * dInt * gGive,
        expFR: lgFr * dFf * gGive, expFF: lgFF * dFf * gGive,
        pTD: clamp(tdfR * 0.03, 0.008, 0.10), pBlk: clamp(blkR * 0.05, 0.01, 0.09),
        attR, defR,
    };
}

function poisSample(uFn, gaussFn, lam) {
    if (lam <= 0) return 0;
    if (lam < 30) {
        const L = Math.exp(-lam); let k = 0, p = 1;
        for (;;) { k++; p *= uFn(); if (p <= L) return k - 1; }
    }
    return Math.max(0, Math.round(lam + gaussFn() * Math.sqrt(lam)));
}

/* Simulate fantasy points under scoring config cfg.
   Returns {ev, p10, p90, boom} using `n` draws. */
function monteCarlo(pr, cfg, n, seed) {
    const gaussFn = makeRng(seed), uFn = mulberry32unit();
    const sd = CFG.MODEL.sd;
    const tiers = cfg.tiers;
    let ev = 0;
    const vals = new Array(n);
    for (let i = 0; i < n; i++) {
        let opp = gaussFn() * sd + pr.expOpp;
        if (opp < 0) opp = 0;
        let sc = tierPts(tiers, Math.round(opp));
        sc += cfg.sack * poisSample(uFn, gaussFn, pr.expSk);
        sc += cfg.int * poisSample(uFn, gaussFn, pr.expInt);
        sc += cfg.ff * poisSample(uFn, gaussFn, pr.expFF);
        sc += cfg.fr * poisSample(uFn, gaussFn, pr.expFR);
        if (uFn() < pr.pTD) sc += cfg.def_td;
        if (uFn() < 0.032) sc += cfg.st_td;
        if (uFn() < 0.005) sc += cfg.safety;
        if (uFn() < pr.pBlk) sc += cfg.blk_kick;
        ev += sc; vals[i] = sc;
    }
    vals.sort((a, b) => a - b);
    const q = p => vals[Math.min(n - 1, Math.max(0, Math.floor(p * n)))];
    let ge = 0;
    for (const v of vals) if (v >= CFG.BOOM_PTS) ge++;
    return { ev: ev / n, p10: q(0.10), p90: q(0.90), boom: ge / n };
}

/* ------------------ Backtester (walk-forward) ------------------ */
function rankArr(vals) {
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    const r = new Array(vals.length);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && vals[idx[j + 1]] === vals[idx[i]]) j++;
        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) r[idx[k]] = avg;
        i = j + 1;
    }
    return r;
}
function spearman(xs, ys) {
    const n = xs.length;
    if (n < 6) return null;
    const a = rankArr(xs), b = rankArr(ys);
    const ma = (n + 1) / 2;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) {
        cov += (a[i] - ma) * (b[i] - ma);
        va += (a[i] - ma) ** 2; vb += (b[i] - ma) ** 2;
    }
    return va && vb ? cov / Math.sqrt(va * vb) : null;
}

async function runBacktest({ recs, events, cfg, firstSeason, sims, onProgress }) {
    const M = CFG.MODEL;
    const res = {
        weeks: 0, rho: 0, top1: 0, top3: 0, median: 0, pool: 0, hitTop1: 0,
        lift3: 0, naiveMatchupTop3: 0, blindHomeAvg: 0, randVsMedian: 0,
        perYear: {}, details: [],
    };
    let ptr = 0;
    const tr = new Tracker(M.hlWeeks);
    if (events.length) tr.t = events[0].t;
    const acc = { rho: [], top1: [], top3: [], med: [], pool: [], hit: 0, naive3: [], home: [] };
    const perYear = {};
    let doneEv = 0;
    for (let wi = 0; wi < events.length; wi++) {
        const evW = events[wi];
        if (onProgress && ++doneEv % 8 === 0) {
            onProgress(`Evaluating ${evW.season} week ${evW.week} (${Math.round(doneEv / events.length * 100)}%)`);
            await new Promise(r => setTimeout(r, 0));
        }
        if (evW.season < firstSeason) continue;
        while (ptr < wi) {
            const pe = events[ptr];
            tr.advance(pe.t - tr.t);
            curT = pe.t;
            for (const r of pe.recs) tr.add(r);
            ptr++;
        }
        const rows = [];
        for (const r of evW.recs) {
            const pr = predictParams(tr, M.K, M.Kv, r.team, r.opp, r.venue);
            if (!pr) continue;
            const sim = monteCarlo(pr, cfg, sims, (evW.season * 100 + evW.week) * 7919 + r.team.charCodeAt(0));
            rows.push({ team: r.team, ev: sim.ev, expOpp: pr.expOpp,
                        actual: actualDefPoints(r, cfg), venue: r.venue });
        }
        if (rows.length < 10) continue;
        const actuals = rows.map(x => x.actual).sort((a, b) => a - b);
        const med = actuals[Math.floor(actuals.length / 2)];
        const poolMean = actuals.reduce((s, v) => s + v, 0) / actuals.length;
        const rho = spearman(rows.map(x => x.ev), rows.map(x => x.actual));
        if (rho !== null) acc.rho.push(rho);
        const byEv = [...rows].sort((a, b) => b.ev - a.ev);
        const t1 = byEv[0].actual;
        const t3 = (byEv[0].actual + (byEv[1]?.actual ?? t1) + (byEv[2]?.actual ?? t1)) / 3;
        const byOpp = [...rows].sort((a, b) => a.expOpp - b.expOpp);
        const n3 = (byOpp[0].actual + (byOpp[1]?.actual ?? t1) + (byOpp[2]?.actual ?? t1)) / 3;
        const homes = rows.filter(x => x.venue === 'H');
        acc.top1.push(t1); acc.top3.push(t3); acc.med.push(med); acc.pool.push(poolMean);
        acc.naive3.push(n3);
        acc.home.push(homes.length ? homes.reduce((s, x) => s + x.actual, 0) / homes.length : poolMean);
        acc.hit += t1 >= med ? 1 : 0;
        const yr = evW.season;
        (perYear[yr] ||= { rho: [], lift: [], weeks: 0 }).weeks++;
        if (rho !== null) perYear[yr].rho.push(rho);
        perYear[yr].lift.push(t3 - med);
        res.details.unshift({ season: evW.season, week: evW.week,
            pick: byEv[0].team, ev: byEv[0].ev, actual: t1, med,
            top3: t3.toFixed(1) });
        res.weeks++;
    }
    const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    res.rho = mean(acc.rho); res.top1 = mean(acc.top1); res.top3 = mean(acc.top3);
    res.median = mean(acc.med); res.pool = mean(acc.pool);
    res.hitTop1 = res.weeks ? acc.hit / res.weeks : 0;
    res.lift3 = res.top3 - res.median;
    res.naiveMatchupTop3 = mean(acc.naive3);
    res.blindHomeAvg = mean(acc.home);
    res.randVsMedian = res.pool - res.median;
    for (const y of Object.keys(perYear)) {
        const p = perYear[y];
        res.perYear[y] = { weeks: p.weeks, rho: mean(p.rho), lift: mean(p.lift) };
    }
    return res;
}
