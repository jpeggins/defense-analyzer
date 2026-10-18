#!/usr/bin/env python3
"""Refresh same-origin data files served by the GitHub Page.

Downloads nflverse games + weekly team stats, projects them to minimal
JSON, gzips them into data/, so browsers never need third-party origins.

Designed for stdlib-only Python (runs identically on a laptop and on a
GitHub Actions runner). Historical season files that already exist are left
untouched (they're immutable once the season completes); the current season's
files are always rewritten.
"""
import csv, gzip, io, json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
GAMES_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv"
STATS_URL = ("https://github.com/nflverse/nflverse-data/releases/download/"
             "stats_team/stats_team_week_{y}.csv.gz")
MIN_SEASON = 2007


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "dststreamer-data/1.0"})
    for attempt in range(3):
        try:
            return urllib.request.urlopen(req, timeout=120).read()
        except Exception as e:
            if attempt == 2:
                raise
            print(f"retry {attempt + 1} for {url}: {e}", file=sys.stderr)


ALIAS = {"LA": "LAR", "STL": "LAR", "SD": "LAC", "OAK": "LV", "SJ": "LV", "WSH": "WAS"}
norm = lambda t: ALIAS.get(t, t)


def games_by_season():
    text = get(GAMES_URL).decode("utf-8-sig")
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        gt = r["game_type"]
        if gt == "PRE":
            continue
        season = int(r["season"])
        out.setdefault(season, []).append({
            "gid": r["game_id"], "season": season, "week": int(r["week"]),
            "post": gt != "REG", "date": r["gameday"],
            "away": norm(r["away_team"]), "home": norm(r["home_team"]),
            "as": None if r["away_score"] == "" else float(r["away_score"]),
            "hs": None if r["home_score"] == "" else float(r["home_score"]),
            "loc": r["location"], "roof": (r.get("roof") or "").lower(),
            "stadium": r.get("stadium_id") or "",
        })
    return out


NUM = lambda v: (lambda x: x if x == x else 0)(float(v or 0))  # NaN->0, ''->0


def stats_rows(season):
    """Same projected schema the browser loader expects."""
    try:
        raw = get(STATS_URL.format(y=season))
    except Exception as e:
        print(f"stats {season} unavailable ({e}); skipping")
        return None
    text = gzip.decompress(raw).decode("utf-8-sig")
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        out.append({
            "gid": r["game_id"], "team": norm(r["team"]),
            "post": 1 if r["season_type"] == "POST" else 0,
            "oi": NUM(r["passing_interceptions"]),
            "ol": NUM(r["sack_fumbles_lost"]) + NUM(r["rushing_fumbles_lost"]) + NUM(r["receiving_fumbles_lost"]),
            "osk": NUM(r["sacks_suffered"]), "oa": NUM(r["attempts"]),
            "opy": NUM(r["passing_yards"]), "ory": NUM(r["rushing_yards"]), "osy": NUM(r["sack_yards_lost"]),
            "opc": NUM(r["carries"]),
            "dsk": NUM(r["def_sacks"]), "din": NUM(r["def_interceptions"]), "dff": NUM(r["def_fumbles_forced"]),
            "dh": NUM(r["def_qb_hits"]),
            "dtd": NUM(r["def_tds"]), "std": NUM(r["special_teams_tds"]), "dsa": NUM(r["def_safeties"]),
            "dbk": NUM(r["fg_blocked"]) + NUM(r["pat_blocked"]),
        })
    return out


def dump_json_gz(path, obj):
    payload = gzip.compress(json.dumps(obj, separators=(",", ":")).encode("utf-8"), compresslevel=9)
    if os.path.exists(path) and open(path, "rb").read() == payload:
        return False
    with open(path, "wb") as f:
        f.write(payload)
    return True


SCHEMA = 2

def existing_schema():
    path = os.path.join(DATA, "meta.json.gz")
    if not os.path.exists(path):
        return SCHEMA          # nothing yet -> treated fresh
    try:
        return json.loads(gzip.decompress(open(path, "rb").read()).decode()).get("schema", 1)
    except Exception:
        return 1


def main():
    os.makedirs(DATA, exist_ok=True)
    force_all = existing_schema() < SCHEMA
    gseasons = games_by_season()
    cur = max(gseasons)                       # latest regular season in data
    changed = []

    for season in sorted(gseasons):
        if season < MIN_SEASON:
            continue
        past_file = os.path.join(DATA, f"games_{season}.json.gz")
        active = season >= cur - 1            # current season (+playoff tail safety margin)
        if os.path.exists(past_file) and not active and not force_all:
            continue
        if dump_json_gz(past_file, gseasons[season]):
            changed.append(f"games_{season}")

        sfile = os.path.join(DATA, f"stats_{season}.json.gz")
        if os.path.exists(sfile) and not active and not force_all:
            continue
        rows = stats_rows(season)
        if rows is not None and dump_json_gz(sfile, rows):
            changed.append(f"stats_{season}")

    import datetime
    meta = {"updated_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes"),
            "schema": SCHEMA}
    if dump_json_gz(os.path.join(DATA, "meta.json.gz"), meta):
        changed.append("meta")

    print("changed:", changed or "nothing (all files up to date)")
    if not changed:
        sys.exit(0)


if __name__ == "__main__":
    main()
