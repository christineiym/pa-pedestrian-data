"""Build municipality + county reference data for Pennsylvania.

Inputs (downloaded into build/raw/census/, see README):
  - cb_2023_42_cousub_500k.zip   Census cartographic county subdivisions (= PA municipalities)
  - cb_2023_us_county_500k.zip   Census cartographic counties
  - pop_*.json                   TIGERweb Census 2020 county-subdivision POP100 (paged)

Outputs:
  - data/municipalities.geojson  simplified polygons; properties id, name, type, county, countyfp, pop, area_km2
  - data/counties.geojson        simplified county polygons; properties id, name, pop, n_munis
"""
import glob
import json
import sys
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "build" / "raw" / "census"
OUT = ROOT / "data"
TOL = 0.0004  # degrees (~35-45 m in PA): enough for a statewide choropleth


def muni_type(namelsad: str) -> str:
    for t in ("township", "borough", "city", "town", "municipality"):
        if namelsad.lower().endswith(" " + t):
            return t
    return "other"


def write_geojson(gdf: gpd.GeoDataFrame, path: Path) -> None:
    gdf = gdf.copy()
    gdf["geometry"] = shapely.set_precision(gdf.geometry.values, 1e-5)
    path.write_text(gdf.to_json(drop_id=True, separators=(",", ":")))
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e6:.1f} MB, {len(gdf)} features)")


def main() -> None:
    pop = pd.DataFrame(
        [f["attributes"] for p in sorted(glob.glob(str(RAW / "pop_*.json"))) for f in json.load(open(p)).get("features", [])]
    )[["GEOID", "POP100"]]

    m = gpd.read_file(f"zip://{RAW / 'cb_2023_42_cousub_500k.zip'}").to_crs(4326)
    m = m[m["COUSUBFP"] != "00000"]  # "county subdivisions not defined" (water)
    m = m.merge(pop, on="GEOID", how="left")
    missing = m["POP100"].isna().sum()
    if missing:
        print(f"warning: {missing} municipalities without 2020 population", file=sys.stderr)

    c = gpd.read_file(f"zip://{RAW / 'cb_2023_us_county_500k.zip'}")
    c = c[c["STATEFP"] == "42"].to_crs(4326)
    county_name = dict(zip(c["COUNTYFP"], c["NAME"]))

    area = m.to_crs(26918).area / 1e6
    muni = gpd.GeoDataFrame(
        {
            "id": m["GEOID"],
            "name": m["NAME"],
            "type": m["NAMELSAD"].map(muni_type),
            "county": m["COUNTYFP"].map(county_name),
            "countyfp": m["COUNTYFP"],
            "pop": m["POP100"].fillna(0).astype(int),
            "area_km2": area.round(2),
        },
        geometry=m.geometry.simplify_coverage(TOL),
        crs=4326,
    ).sort_values(["county", "name"])
    write_geojson(muni, OUT / "municipalities.geojson")

    agg = muni.groupby("countyfp").agg(pop=("pop", "sum"), n_munis=("id", "count")).reset_index()
    c = c.merge(agg, left_on="COUNTYFP", right_on="countyfp")
    county = gpd.GeoDataFrame(
        {"id": c["COUNTYFP"], "name": c["NAME"], "pop": c["pop"], "n_munis": c["n_munis"]},
        geometry=c.geometry.simplify_coverage(TOL * 2),
        crs=4326,
    ).sort_values("name")
    write_geojson(county, OUT / "counties.geojson")

    print(muni["type"].value_counts().to_dict(), "total pop", int(muni["pop"].sum()))


if __name__ == "__main__":
    main()
