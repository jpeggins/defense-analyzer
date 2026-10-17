/* ================================================================
   D/ST Streamer — configuration: data sources, teams, venues,
   scoring presets, tuned model parameters.
   Model parameters were fit via walk-forward backtest on 2020-2026
   (see Backtest tab; details in README).
   ================================================================ */
const CFG = {
    DATA: {
        // same-origin pre-sliced nflverse data (refreshed nightly by .github/workflows)
        local: 'data/',
        sleeperApi: 'https://api.sleeper.app/v1',
        openMeteo: 'https://api.open-meteo.com/v1/forecast',
    },
    CACHE_TTL_HOURS: 12,           // nflverse/Sleeper refresh daily; half a day keeps launches instant
    HISTORY_MIN_SEASON: 2007,          // box-score components fully available
    HISTORY_DEFAULT_START: 2016,       // recommended window (modern era-ish)
    MODEL: {
        hlWeeks: 45,   // exponential half-life of game weighting (weeks)
        K: 8,          // shrinkage toward league average (in weighted-games)
        Kv: 8,         // home/away split shrinkage
        sd: 8.5,       // assumed sd of simulated opponent points
        sims: 1500,    // Monte-Carlo draws per live projection
        btSims: 600,   // lighter sims for the backtester
        caps: { att: [0.62, 1.55], stat: [0.40, 2.1], give: [0.45, 2.0] },
        yardsBlend: 0,   // weight of yards-rates in attack/vulnerability ratings (tuned via Backtest)
    },
    WEATHER: {
        // modifiers applied to EXPECTED OPPONENT POINTS (lower = better for D/ST)
        windKmH: [[35, 0.935], [28, 0.965]],   // sustained max wind thresholds
        precipMm: [[10, 0.965]],               // total precipitation
        minFloor: 0.92,
        forecastWindowDays: 9,
    },
    BOOM_PTS: 9.0,   // threshold for the "boom %" upside stat
};

/* Team display info + home venue defaults (approx lat/lng is plenty). */
const TEAMS = {
    ARI: { name: 'Cardinals',      city: 'Arizona',      lat: 33.529,  lng: -112.138, dome: true  },
    ATL: { name: 'Falcons',         city: 'Atlanta',      lat: 33.755,  lng: -84.401,  dome: true  },
    BAL: { name: 'Ravens',          city: 'Baltimore',    lat: 39.278,  lng: -76.625,  dome: false },
    BUF: { name: 'Bills',           city: 'Buffalo',      lat: 42.774,  lng: -78.787,  dome: false },
    CAR: { name: 'Panthers',        city: 'Carolina',     lat: 35.226,  lng: -80.852,  dome: false },
    CHI: { name: 'Bears',           city: 'Chicago',      lat: 41.862,  lng: -87.617,  dome: false },
    CIN: { name: 'Bengals',         city: 'Cincinnati',   lat: 39.095,  lng: -84.515,  dome: false },
    CLE: { name: 'Browns',          city: 'Cleveland',    lat: 41.437,  lng: -81.679,  dome: false },
    DAL: { name: 'Cowboys',         city: 'Dallas',       lat: 32.747,  lng: -97.099,  dome: true  },
    DEN: { name: 'Broncos',         city: 'Denver',       lat: 39.743,  lng: -105.021, dome: false },
    DET: { name: 'Lions',           city: 'Detroit',      lat: 42.340,  lng: -83.046,  dome: true  },
    GB:  { name: 'Packers',         city: 'Green Bay',    lat: 44.501,  lng: -88.062,  dome: false },
    HOU: { name: 'Texans',          city: 'Houston',      lat: 29.685,  lng: -95.411,  dome: true  },
    IND: { name: 'Colts',           city: 'Indianapolis', lat: 39.760,  lng: -86.164,  dome: true  },
    JAX: { name: 'Jaguars',         city: 'Jacksonville', lat: 30.324,  lng: -81.637,  dome: false },
    KC:  { name: 'Chiefs',          city: 'Kansas City',  lat: 39.049,  lng: -94.483,  dome: false },
    LAC: { name: 'Chargers',        city: 'Los Angeles',  lat: 33.953,  lng: -118.339, dome: false },
    LAR: { name: 'Rams',            city: 'Los Angeles',  lat: 33.953,  lng: -118.339, dome: false },
    LV:  { name: 'Raiders',         city: 'Las Vegas',    lat: 36.091,  lng: -115.183, dome: true  },
    MIA: { name: 'Dolphins',        city: 'Miami',        lat: 25.958,  lng: -80.239,  dome: false },
    MIN: { name: 'Vikings',         city: 'Minnesota',    lat: 44.974,  lng: -93.257,  dome: true  },
    NE:  { name: 'Patriots',        city: 'New England',  lat: 42.091,  lng: -71.265,  dome: false },
    NO:  { name: 'Saints',          city: 'New Orleans',  lat: 29.951,  lng: -90.082,  dome: true  },
    NYG: { name: 'Giants',          city: 'New York',     lat: 40.813,  lng: -74.074,  dome: false },
    NYJ: { name: 'Jets',            city: 'New York',     lat: 40.813,  lng: -74.074,  dome: false },
    PHI: { name: 'Eagles',          city: 'Philadelphia', lat: 39.901,  lng: -75.167,  dome: false },
    PIT: { name: 'Steelers',        city: 'Pittsburgh',   lat: 40.447,  lng: -80.016,  dome: false },
    SEA: { name: 'Seahawks',        city: 'Seattle',      lat: 47.595,  lng: -122.332, dome: false },
    SF:  { name: '49ers',           city: 'San Francisco',lat: 37.323,  lng: -121.970, dome: false },
    TB:  { name: 'Buccaneers',      city: 'Tampa Bay',    lat: 27.976,  lng: -82.503,  dome: true  },
    TEN: { name: 'Titans',          city: 'Tennessee',    lat: 36.166,  lng: -86.781,  dome: false },
    WAS: { name: 'Commanders',      city: 'Washington',   lat: 38.920,  lng: -76.857,  dome: false },
};

/* Historical team-code aliases -> current codes (nflverse keeps old names). */
const TEAM_ALIAS = { LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV', SJ: 'LV', WSH: 'WAS' };
function normTeam(t) { return TEAM_ALIAS[t] || t; }
function teamLabel(t) { const x = TEAMS[normTeam(t)]; return x ? `${x.city} ${x.name}` : t; }

/* Non-home / international venues referenced by nflverse stadium_id. */
const INTL_VENUES = {
    LON00: { label: 'Wembley (London)',        lat: 51.5542, lng: -0.2793,  dome: false },
    LON01: { label: 'Tottenham (London)',      lat: 51.6043, lng: -0.0666,  dome: false },
    LON02: { label: 'London',                  lat: 51.5074, lng: -0.1278,  dome: false },
    MEX00: { label: 'Estadio Azteca (Mexico City)', lat: 19.3029, lng: -99.1505, dome: false },
    RIO00: { label: 'São Paulo',               lat: -23.5983, lng: -46.4440, dome: false },
    FRA00: { label: 'Frankfurt',               lat: 50.0686, lng: 8.6634,   dome: false },
    MUN01: { label: 'Munich',                  lat: 48.2188, lng: 11.6247,  dome: false },
    GER00: { label: 'Gelsenkirchen',           lat: 51.5543, lng: 7.0684,   dome: false },
    MAD01: { label: 'Madrid',                  lat: 40.4531, lng: -3.6883,  dome: false },
    PAR00: { label: 'Stade de France (Paris)', lat: 48.9244, lng: 2.3601,   dome: false },
    MEL00: { label: 'Melbourne',               lat: -37.8197, lng: 144.9834, dome: false },
    SYD00: { label: 'Sydney',                  lat: -33.8600, lng: 151.2060, dome: false },
};

/* ------------------------- scoring systems ------------------------- */
/* tiers: [lowestPointsAllowed, value]; component keys multiply counts */
const SCORING_PRESETS = [
    {
        id: 'sleeper', label: 'Sleeper Default (sacks=1, takeaways)',
        tiers: [[0, 10], [1, 7], [7, 4], [14, 1], [21, 0], [28, -1], [35, -4]],
        sack: 1, int: 2, ff: 0, fr: 2, def_td: 6, st_td: 6, safety: 2, blk_kick: 2,
    },
    {
        id: 'bat', label: 'BAT Classic (classic standard)',
        tiers: [[0, 10], [1, 7], [7, 4], [14, 0], [18, -1], [22, -2], [28, -3], [36, -4]],
        sack: 1, int: 2, ff: 0, fr: 1, def_td: 6, st_td: 6, safety: 2, blk_kick: 2,
    },
    {
        id: 'tieronly', label: 'Tier-only (no sacks/takeaways bonuses)',
        tiers: [[0, 10], [1, 7], [7, 4], [14, 1], [21, 0], [28, -1], [35, -4]],
        sack: 0, int: 0, ff: 0, fr: 0, def_td: 6, st_td: 6, safety: 2, blk_kick: 2,
    },
];

/* Build a scoring config from a Sleeper league's own scoring_settings.
   (Sleeper fixes the tier boundaries; component values come from settings.) */
function scoringFromSleeperSettings(ss, countSacks) {
    const g = (k, d) => (typeof ss[k] === 'number' ? ss[k] : d);
    return {
        id: 'league', label: 'Your league settings',
        tiers: [
            [0, g('pts_allow_0', 10)], [1, g('pts_allow_1_6', 7)], [7, g('pts_allow_7_13', 4)],
            [14, g('pts_allow_14_20', 1)], [21, g('pts_allow_21_27', 0)],
            [28, g('pts_allow_28_34', -1)], [35, g('pts_allow_35p', -4)],
        ],
        sack: countSacks ? g('sack', 1) : 0,
        int: g('int', 2), ff: g('ff', 0) > 0 ? g('ff', 0) : 0, fr: g('fum_rec', 2),
        def_td: g('def_st_td', 0) || g('def_td', 6), st_td: g('st_td', 0) || g('def_st_td', 6),
        safety: g('safe', 2), blk_kick: g('blk_kick', 2),
    };
}
