"""Precompute OpenStreetMap pedestrian-accessibility metrics for every PA municipality.

Input:  build/raw/osm/pennsylvania-latest.osm.pbf  (Geofabrik extract)
        data/municipalities.geojson                (from build_municipalities.py)
Output: data/osm_coverage.json

Every metric is an additive SUM per municipality, so the dashboard can aggregate exactly to
counties or population bands, then derive ratios and coverage levels (see osmLevels in js/app.js).
Each way is assigned to the municipality containing its middle node; each node by its location.
The classification mirrors classify() in js/app.js.
"""
import json
import pickle
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import osmium
import shapely

ROOT = Path(__file__).resolve().parent.parent
PBF = ROOT / "build" / "raw" / "osm" / "pennsylvania-latest.osm.pbf"
PED_GEOMS = ROOT / "build" / "derived" / "osm_ped_geoms.pkl"  # used by transit_coverage.py

FIELDS = [
    "sw_n", "sw_len", "st_len", "imp_len",                 # sidewalk ways, sidewalk m, street m, street m implied by sidewalk=*
    "sw_width", "sw_surface", "sw_incline", "sw_smooth",   # sidewalk ways carrying each tag
    "x_n", "x_nodes", "kerb_n", "tact_n",                  # crossings (ways+nodes), crossing nodes, kerb nodes, crossings/kerbs w/ tactile_paving
    "sig_n", "aps_n", "steps_n",                           # signalized crossing nodes, of which traffic_signals:sound, steps ways
    "stop_n", "stop_wc", "stop_wc_yes", "stop_tactile", "stop_shelter", "stop_bench",  # transit stops (reported, not scored)
]
IX = {f: i for i, f in enumerate(FIELDS)}
STREETS = {"primary", "secondary", "tertiary", "residential", "unclassified", "living_street"}


def classify(t):
    if t.get("highway") == "footway" and t.get("footway") == "sidewalk":
        return "sidewalk"
    if t.get("footway") == "crossing" or t.get("highway") == "crossing":
        return "crossing"
    if "kerb" in t or t.get("barrier") == "kerb":
        return "curb"
    if t.get("highway") == "steps":
        return "steps"
    return "street" if t.get("highway") in STREETS else None


def is_stop(t):
    return t.get("highway") == "bus_stop" or t.get("public_transport") == "platform" or t.get("railway") in ("platform", "station", "halt")


def main():
    if not PBF.exists():
        sys.exit(f"missing {PBF}; see README for the download step")
    t0 = time.time()
    pts, rows = [], []
    ped_lines, ped_points = [], []  # pedestrian network geometry for stop-connectivity checks

    def emit(lon, lat, **vals):
        v = [0.0] * len(FIELDS)
        for k, x in vals.items():
            v[IX[k]] = x
        pts.append((lon, lat))
        rows.append(v)

    fp = (osmium.FileProcessor(str(PBF))
          .with_locations()
          .with_filter(osmium.filter.KeyFilter("highway", "footway", "kerb", "barrier", "public_transport", "railway")))
    for o in fp:
        t = {tag.k: tag.v for tag in o.tags}
        if o.is_node():
            loc = o.location
            if not loc.valid():
                continue
            if is_stop(t):
                wc = t.get("wheelchair")
                emit(loc.lon, loc.lat, stop_n=1, stop_wc=wc is not None, stop_wc_yes=wc in ("yes", "limited"),
                     stop_tactile="tactile_paving" in t, stop_shelter="shelter" in t, stop_bench="bench" in t)
            c = classify(t)
            if c == "crossing":
                sig = t.get("crossing") == "traffic_signals" or t.get("crossing:signals") == "yes"
                emit(loc.lon, loc.lat, x_n=1, x_nodes=1, tact_n="tactile_paving" in t,
                     sig_n=sig, aps_n=sig and "traffic_signals:sound" in t)
                ped_points.append((loc.lon, loc.lat))
            elif c == "curb":
                emit(loc.lon, loc.lat, kerb_n=1, tact_n="tactile_paving" in t)
        elif o.is_way():
            c = classify(t)
            if c is None:
                continue
            try:
                length = osmium.geom.haversine_distance(o.nodes)
                mid = o.nodes[len(o.nodes) // 2].location
                lon, lat = mid.lon, mid.lat
            except osmium.InvalidLocationError:
                continue
            if c in ("sidewalk", "crossing") or (c == "street" and (t.get("sidewalk") or t.get("sidewalk:both")) in ("both", "yes", "left", "right")):
                ped_lines.append([(n.lon, n.lat) for n in o.nodes])
            if c == "sidewalk":
                emit(lon, lat, sw_n=1, sw_len=length, sw_width="width" in t, sw_surface="surface" in t,
                     sw_incline="incline" in t, sw_smooth="smoothness" in t)
            elif c == "crossing":
                emit(lon, lat, x_n=1, tact_n="tactile_paving" in t)
            elif c == "steps":
                emit(lon, lat, steps_n=1)
            elif c == "street":
                s = t.get("sidewalk") or t.get("sidewalk:both")
                emit(lon, lat, st_len=length, imp_len=2 * length if s in ("both", "yes") else length if s in ("left", "right") else 0)
    print(f"parsed {len(rows):,} features in {time.time() - t0:.0f}s")
    PED_GEOMS.parent.mkdir(parents=True, exist_ok=True)
    with open(PED_GEOMS, "wb") as fh:
        pickle.dump({"lines": ped_lines, "points": ped_points}, fh)
    print(f"saved {len(ped_lines):,} pedestrian lines + {len(ped_points):,} crossing nodes to {PED_GEOMS.relative_to(ROOT)}")

    munis = gpd.read_file(ROOT / "data" / "municipalities.geojson", engine="pyogrio")
    ids = munis["id"].to_numpy()
    tree = shapely.STRtree(munis.geometry.values)
    P = shapely.points(np.asarray(pts))
    pi, mi = tree.query(P, predicate="within")
    V = np.asarray(rows, dtype=np.float64)
    acc = np.zeros((len(munis), len(FIELDS)))
    np.add.at(acc, mi, V[pi])
    print(f"assigned {len(np.unique(pi)):,}/{len(rows):,} features to municipalities in {time.time() - t0:.0f}s")

    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": f"OpenStreetMap via Geofabrik extract ({datetime.fromtimestamp(PBF.stat().st_mtime, timezone.utc):%Y-%m-%d} download)",
        "fields": FIELDS,
        "munis": {ids[i]: [round(x, 1) if FIELDS[j].endswith("len") else int(x) for j, x in enumerate(acc[i])] for i in range(len(ids))},
    }
    path = ROOT / "data" / "osm_coverage.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    tot = acc.sum(0)
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e6:.2f} MB)")
    print({f: int(tot[i]) for i, f in enumerate(FIELDS)})


if __name__ == "__main__":
    main()
