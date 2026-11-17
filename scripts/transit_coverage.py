"""Fixed-route transit accessibility-data metrics + derived ADA paratransit area for PA municipalities.

Inputs:  build/raw/gtfs/feeds/*.zip, build/raw/gtfs/manifest.json   (scripts/fetch_gtfs.py)
         data/municipalities.geojson                               (scripts/build_municipalities.py)
         build/derived/osm_ped_geoms.pkl                           (scripts/osm_coverage.py)
Outputs: data/transit_feeds.json      per-feed audit of GTFS accessibility fields
         data/transit_coverage.json   additive per-municipality sums (+ agencies serving each)
         data/transit_stops.json      deduplicated stops (compact), loaded lazily by the app
         data/paratransit_ada.geojson DERIVED minimum ADA complementary-paratransit area

Paratransit area (49 CFR 37.131): 3/4 mile around non-commuter fixed bus routes and around
light-rail / subway stations. Commuter rail, intercity coach and demand-response routes are excluded.
Commuter *bus* is also exempt under the rule but cannot be identified from GTFS, so it is included:
the result is an approximation of the minimum required area, not any agency's official service area.
"""
import io
import json
import pickle
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "build" / "raw" / "gtfs"
OUT = ROOT / "data"
METRIC_CRS = 5070          # CONUS Albers, metres
ADA_BUFFER_M = 1207.0      # 3/4 mile
SIDEWALK_RADIUS_M = 20.0
INTERCITY = ("trailways", "trans-bridge", "fullington")  # intercity coach operators (not ADA paratransit)


def kind(route_type: int) -> str:
    """Classify (basic or extended) GTFS route_type for the ADA rule."""
    if route_type in (0, 1, 12) or 400 <= route_type < 500 or 900 <= route_type < 1000:
        return "rail_ada"            # light rail / subway / tram: station buffers
    if route_type == 2 or 100 <= route_type < 200:
        return "commuter_rail"       # excluded
    if route_type == 715 or 1500 <= route_type < 1600 or route_type == 200 or 200 <= route_type < 300:
        return "excluded"            # demand-responsive, coach
    return "bus"                     # bus, trolleybus, cable car, ferry...: route buffers


def gtfs_tables(zpath: Path):
    """Yield dicts of {filename: DataFrame-reader} for each GTFS feed in the zip (handles nested zips/dirs)."""
    z = zipfile.ZipFile(zpath)
    names = z.namelist()
    stops = [n for n in names if n.split("/")[-1] == "stops.txt"]
    if stops:
        for s in stops:
            prefix = s[: -len("stops.txt")]
            files = {n[len(prefix):]: n for n in names if n.startswith(prefix) and "/" not in n[len(prefix):]}
            yield lambda f, usecols=None, z=z, files=files: (
                pd.read_csv(z.open(files[f]), dtype=str, encoding="utf-8-sig", usecols=usecols, low_memory=False)
                if f in files else None
            ), set(files)
    else:
        for n in names:
            if n.endswith(".zip"):
                inner = io.BytesIO(z.read(n))
                tmp = zpath.parent / f".{zpath.stem}__{Path(n).stem}.zip"
                tmp.write_bytes(inner.getvalue())
                yield from gtfs_tables(tmp)


def col(df, name, default=""):
    return df[name].fillna(default) if df is not None and name in df.columns else pd.Series(default, index=df.index if df is not None else [])


def process_feed(meta, read, files):
    stops = read("stops.txt")
    routes = read("routes.txt")
    trips = read("trips.txt")
    st = read("stop_times.txt", usecols=lambda c: c in ("trip_id", "stop_id", "stop_sequence"))
    if stops is None or routes is None or trips is None or st is None:
        return None
    stops["location_type"] = col(stops, "location_type", "0").replace("", "0")
    stops["wheelchair_boarding"] = col(stops, "wheelchair_boarding", "0").replace("", "0")
    stops["parent_station"] = col(stops, "parent_station")
    # inherit wheelchair_boarding from parent station when the child leaves it empty/0 (GTFS spec)
    parent_wb = dict(zip(stops.loc[stops.location_type == "1", "stop_id"], stops.loc[stops.location_type == "1", "wheelchair_boarding"]))
    wb = stops["wheelchair_boarding"].where(stops["wheelchair_boarding"] != "0", stops["parent_station"].map(parent_wb).fillna("0"))
    stops["wb"] = pd.to_numeric(wb, errors="coerce").fillna(0).astype(int).clip(0, 2)
    stops["lat"] = pd.to_numeric(stops["stop_lat"], errors="coerce")
    stops["lon"] = pd.to_numeric(stops["stop_lon"], errors="coerce")

    routes["kind"] = pd.to_numeric(routes["route_type"], errors="coerce").fillna(3).astype(int).map(kind)
    if any(k in meta["provider"].lower() for k in INTERCITY):
        routes["kind"] = "excluded"
    trips = trips.merge(routes[["route_id", "kind"]], on="route_id", how="left")
    st = st.merge(trips[["trip_id", "kind"]], on="trip_id", how="left")

    served = stops[stops.stop_id.isin(st.stop_id.unique()) & stops.location_type.isin(["0"]) & stops.lat.notna()].copy()
    stop_kinds = st.groupby("stop_id")["kind"].agg(lambda s: set(s.dropna()))
    served["kinds"] = served.stop_id.map(stop_kinds)

    # --- paratransit geometry (metric CRS) ---
    geoms = []
    rail_stops = served[served.kinds.map(lambda k: "rail_ada" in k)]
    geoms += list(shapely.points(rail_stops[["lon", "lat"]].to_numpy()))
    bus_trips = trips[trips.kind == "bus"]
    shapes = read("shapes.txt") if "shapes.txt" in files else None
    bus_lines = []
    if shapes is not None and "shape_id" in bus_trips.columns and bus_trips.shape_id.notna().any():
        shapes["seq"] = pd.to_numeric(shapes.shape_pt_sequence, errors="coerce")
        shapes = shapes[shapes.shape_id.isin(bus_trips.shape_id.dropna().unique())].sort_values(["shape_id", "seq"])
        for _, g in shapes.groupby("shape_id"):
            xy = g[["shape_pt_lon", "shape_pt_lat"]].astype(float).to_numpy()
            if len(xy) >= 2:
                bus_lines.append(shapely.linestrings(xy))
    else:  # fall back to stop sequences of one trip per route
        one_trip = bus_trips.drop_duplicates("route_id").trip_id
        sub = st[st.trip_id.isin(one_trip)].copy()
        sub["seq"] = pd.to_numeric(sub.stop_sequence, errors="coerce")
        sub = sub.merge(stops[["stop_id", "lon", "lat"]], on="stop_id").dropna(subset=["lon", "lat"]).sort_values(["trip_id", "seq"])
        for _, g in sub.groupby("trip_id"):
            if len(g) >= 2:
                bus_lines.append(shapely.linestrings(g[["lon", "lat"]].to_numpy()))
    geoms += bus_lines
    area = None
    if geoms:
        gs = gpd.GeoSeries(geoms, crs=4326).to_crs(METRIC_CRS)
        area = shapely.union_all(shapely.buffer(gs.values, ADA_BUFFER_M, quad_segs=4))

    # --- feed audit ---
    end_dates = []
    for f in ("calendar.txt", "calendar_dates.txt"):
        df = read(f) if f in files else None
        if df is not None:
            c = "end_date" if f == "calendar.txt" else "date"
            if c in df.columns:
                end_dates.append(pd.to_numeric(df[c], errors="coerce").max())
    end = int(max(end_dates)) if end_dates and not all(pd.isna(end_dates)) else None
    twa = col(trips, "wheelchair_accessible", "0").replace("", "0")
    audit = {
        "id": meta["id"], "provider": meta["provider"], "name": meta.get("name", ""), "url": meta["url"],
        "producer_url": meta.get("producer_url", ""), "license": meta.get("license", ""), "fetched": meta["fetched"],
        "stops": int(len(served)), "routes": int(len(routes)),
        "modes": sorted(set(routes.kind)),
        "stops_wb_specified": float((served.wb > 0).mean()) if len(served) else 0.0,
        "stops_wb_accessible": float((served.wb == 1).mean()) if len(served) else 0.0,
        "trips_wa_specified": float((twa != "0").mean()) if len(twa) else 0.0,
        "has_pathways": "pathways.txt" in files, "has_levels": "levels.txt" in files,
        "has_shapes": "shapes.txt" in files, "has_feed_info": "feed_info.txt" in files,
        "service_end": end,
        "expired": bool(end and end < int(date.today().strftime("%Y%m%d"))),
        "paratransit_basis": "shapes" if shapes is not None and bus_lines else ("stop sequences" if bus_lines else "rail stations only" if len(rail_stops) else "none"),
    }
    names = col(served, "stop_name")
    return audit, served.assign(stop_name=names)[["lon", "lat", "wb", "stop_name"]], area


def main():
    manifest = [m for m in json.load(open(RAW / "manifest.json")) if not m["status"].startswith("failed")]
    audits, stop_frames, areas = [], [], []
    for i, meta in enumerate(manifest):
        for read, files in gtfs_tables(RAW / "feeds" / f"{meta['id']}.zip"):
            try:
                res = process_feed(meta, read, files)
            except Exception as e:
                print(f"  ! {meta['id']} failed: {e}")
                continue
            if not res:
                print(f"  ! {meta['id']} missing core files")
                continue
            audit, stops, area = res
            audits.append(audit)
            stop_frames.append(stops.assign(feed=len(audits) - 1))
            if area is not None:
                areas.append(area)
            print(f"{meta['id']:12} {audit['stops']:6} stops  wb {audit['stops_wb_specified']:.0%}  {audit['paratransit_basis']:16} {meta['provider'][:50]}")

    munis = gpd.read_file(ROOT / "data" / "municipalities.geojson", engine="pyogrio")
    pa = shapely.union_all(munis.to_crs(METRIC_CRS).geometry.values)

    # --- dedupe stops across feeds (same physical location ~1 m) ---
    S = pd.concat(stop_frames, ignore_index=True)
    S["key"] = S.lon.round(5).astype(str) + "," + S.lat.round(5).astype(str)
    agg = S.groupby("key").agg(lon=("lon", "first"), lat=("lat", "first"), name=("stop_name", "first"),
                               wb_yes=("wb", lambda w: (w == 1).any()), wb_no=("wb", lambda w: (w == 2).any()),
                               feeds=("feed", lambda f: sorted(set(f)))).reset_index(drop=True)
    agg["wb"] = np.where(agg.wb_yes, 1, np.where(agg.wb_no, 2, 0))
    pts = gpd.GeoSeries(shapely.points(agg[["lon", "lat"]].to_numpy()), crs=4326)
    tree = shapely.STRtree(munis.geometry.values)
    pi, mi = tree.query(pts.values, predicate="within")
    agg["muni"] = None
    agg.loc[pi, "muni"] = munis.id.to_numpy()[mi]
    agg = agg[agg.muni.notna()].reset_index(drop=True)
    print(f"{len(S):,} stop records -> {len(agg):,} unique stops in PA")
    pa_counts = pd.Series([f for fs in agg.feeds for f in fs]).value_counts()
    for i, a in enumerate(audits):
        a["pa_stops"] = int(pa_counts.get(i, 0))

    # --- stop to OSM pedestrian network ---
    ped = pickle.load(open(ROOT / "build" / "derived" / "osm_ped_geoms.pkl", "rb"))
    ped_geoms = [shapely.linestrings(c) for c in ped["lines"] if len(c) >= 2] + list(shapely.points(np.asarray(ped["points"])))
    ped_m = gpd.GeoSeries(ped_geoms, crs=4326).to_crs(METRIC_CRS).values
    stops_m = gpd.GeoSeries(shapely.points(agg[["lon", "lat"]].to_numpy()), crs=4326).to_crs(METRIC_CRS).values
    si, _ = shapely.STRtree(ped_m).query(stops_m, predicate="dwithin", distance=SIDEWALK_RADIUS_M)
    agg["sw20"] = 0
    agg.loc[np.unique(si), "sw20"] = 1

    # --- paratransit area (dissolved, clipped to PA) ---
    para = shapely.intersection(shapely.union_all(areas), pa) if areas else None
    munis_m = munis.to_crs(METRIC_CRS)
    para_km2 = shapely.area(shapely.intersection(munis_m.geometry.values, para)) / 1e6 if para is not None else np.zeros(len(munis))

    # --- per-municipality sums ---
    FIELDS = ["t_stops", "t_wb_spec", "t_wb_yes", "t_wb_no", "t_sw20", "t_para_km2"]
    g = agg.groupby("muni")
    sums = pd.DataFrame({
        "t_stops": g.size(), "t_wb_spec": g.wb.apply(lambda w: (w > 0).sum()),
        "t_wb_yes": g.wb.apply(lambda w: (w == 1).sum()), "t_wb_no": g.wb.apply(lambda w: (w == 2).sum()),
        "t_sw20": g.sw20.sum(),
    })
    agencies = g.feeds.apply(lambda fs: sorted({audits[f]["provider"] for ff in fs for f in ff}))
    out_munis, out_agencies = {}, {}
    for mid, km2 in zip(munis.id, para_km2):
        row = sums.loc[mid] if mid in sums.index else None
        out_munis[mid] = [int(row[f]) if row is not None else 0 for f in FIELDS[:-1]] + [round(float(km2), 2)]
        if mid in agencies.index:
            out_agencies[mid] = agencies.loc[mid]

    gen = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (OUT / "transit_feeds.json").write_text(json.dumps({"generated": gen, "feeds": audits}, indent=1))
    (OUT / "transit_coverage.json").write_text(json.dumps(
        {"generated": gen, "fields": FIELDS, "munis": out_munis, "agencies": out_agencies}, separators=(",", ":")))
    providers = sorted({a["provider"] for a in audits})
    pidx = {p: i for i, p in enumerate(providers)}
    (OUT / "transit_stops.json").write_text(json.dumps({
        "generated": gen, "agencies": providers,
        "columns": ["lon", "lat", "wheelchair_boarding", "near_sidewalk", "name", "agencies"],
        "stops": [[round(r.lon, 5), round(r.lat, 5), int(r.wb), int(r.sw20), r.name if isinstance(r.name, str) else "",
                   sorted({pidx[audits[f]["provider"]] for f in r.feeds})] for r in agg.itertuples()],
    }, separators=(",", ":"), ensure_ascii=False))
    if para is not None:
        para_gdf = gpd.GeoDataFrame(
            {"basis": ["Derived: 3/4 mile around non-commuter fixed bus routes and light-rail/subway stations (49 CFR 37.131). Not an official service area."]},
            geometry=[shapely.simplify(para, 40)], crs=METRIC_CRS).to_crs(4326)
        para_gdf["geometry"] = shapely.set_precision(para_gdf.geometry.values, 1e-5)
        (OUT / "paratransit_ada.geojson").write_text(para_gdf.to_json(drop_id=True, separators=(",", ":")))
    for f in ("transit_feeds.json", "transit_coverage.json", "transit_stops.json", "paratransit_ada.geojson"):
        print(f"wrote data/{f} ({(OUT / f).stat().st_size / 1e6:.2f} MB)")
    print(f"stops: {len(agg):,}; wb specified {(agg.wb > 0).mean():.1%}; accessible {(agg.wb == 1).mean():.1%}; "
          f"within {SIDEWALK_RADIUS_M:.0f} m of OSM ped network {agg.sw20.mean():.1%}; paratransit area {para_km2.sum():,.0f} km²")


if __name__ == "__main__":
    main()
