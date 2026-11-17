# PA pedestrian accessibility data coverage (prototype)

A static dashboard showing which pedestrian accessibility data exists for all 2,572 Pennsylvania municipalities. You can group by county, population size or municipality type, preview datasets as map layers, inspect each dataset's schema, and export CSV. See [PLAN.md](PLAN.md) for goals, the data model and next phases.

## Run

```sh
python3 -m http.server 8765
# http://localhost:8765            statewide
# http://localhost:8765/#c=Allegheny   county
# http://localhost:8765/#m=4200361000  municipality (Census GEOID)
# http://localhost:8765/?layers=para,stops#m=4200361000  with paratransit + GTFS stop overlays
```

There is no build step. The app uses Leaflet from cdnjs, OSM basemap tiles, and the Overpass API (with mirror fallback) for live OSM layer previews.

## Rebuilding the data

The generated files in `data/` are committed. To regenerate them:

```sh
python3 -m venv --system-site-packages .venv && .venv/bin/pip install -r requirements.txt
mkdir -p build/raw/census build/raw/osm

# 1. Municipal and county boundaries (Census cartographic files, 2023)
curl -o build/raw/census/cb_2023_42_cousub_500k.zip https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_42_cousub_500k.zip
curl -o build/raw/census/cb_2023_us_county_500k.zip https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip

# 2. 2020 population (TIGERweb, no API key needed; 3 pages of 1,000)
for off in 0 1000 2000; do
  curl -o build/raw/census/pop_$off.json "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/20/query?where=STATE%3D%2742%27&outFields=GEOID,POP100&returnGeometry=false&resultOffset=$off&resultRecordCount=1000&f=json"
done
.venv/bin/python scripts/build_municipalities.py   # -> data/municipalities.geojson, data/counties.geojson

# 3. OSM metrics per municipality (~350 MB extract, ~35 s to process)
curl -L -o build/raw/osm/pennsylvania-latest.osm.pbf https://download.geofabrik.de/north-america/us/pennsylvania-latest.osm.pbf
.venv/bin/python scripts/osm_coverage.py           # -> data/osm_coverage.json (+ build/derived/osm_ped_geoms.pkl)

# 4. Fixed-route transit (GTFS via Mobility Database catalog; ~140 MB of feeds)
mkdir -p build/raw/gtfs
curl -L -o build/raw/gtfs/feeds_v2.csv https://files.mobilitydatabase.org/feeds_v2.csv
curl -L -o build/raw/gtfs/mdb_catalog.csv https://share.mobilitydata.org/catalogs-csv
.venv/bin/python scripts/fetch_gtfs.py              # -> build/raw/gtfs/feeds/*.zip
.venv/bin/python scripts/transit_coverage.py        # -> data/transit_*.json, data/paratransit_ada.geojson
```

Step 4 needs step 3's output (for the stop-to-sidewalk check).

## Files
- `data/catalog.json`: the dataset catalog. **All datasets except OSM are unverified candidates** and are left out of scores unless you tick "Include unverified" in the app. `coverage.municipalities` takes Census GEOIDs; `coverage.counties` takes county names.
- `data/schema.json`: the common accessibility attribute vocabulary (OSM/OpenSidewalks-aligned).
- `data/municipalities.geojson`, `data/counties.geojson`: simplified boundaries with 2020 population.
- `data/osm_coverage.json`: additive OSM metrics per municipality, so county and population-band totals are exact sums.
- `data/transit_feeds.json`, `data/transit_coverage.json`, `data/transit_stops.json`: GTFS feed audit, per-municipality transit sums, and deduplicated stops (loaded only when the stop layer is shown).
- `data/paratransit_ada.geojson`: the **derived** minimum ADA paratransit area (¾ mile around fixed bus routes and rail stations). It is not an official service area.
- `js/app.js`: views, coverage scoring (`osmLevels()` holds the thresholds), layer previews, schema inference and CSV export.
- `scripts/`: the data build scripts.
