# PA pedestrian accessibility data coverage (prototype)

**Live site:** https://christineiym.github.io/pa-pedestrian-data/

A static dashboard showing which pedestrian accessibility data exists for all 2,572 Pennsylvania municipalities. You can group by county, population size or municipality type, preview datasets as map layers, inspect each dataset's schema, and export CSV. Fixed-route transit (GTFS) accessibility data and a derived ADA paratransit area are shown alongside. See [PLAN.md](PLAN.md) for goals, the data model, the method and next phases.

> **Prototype.** Except for OpenStreetMap and GTFS, the datasets in the catalog are unverified candidates and are left out of scores by default. OSM coverage thresholds are uncalibrated placeholders. The paratransit layer is derived from the ADA minimum rule, not from official service areas. See "Caveats" below.

## Run locally

```sh
python3 -m http.server 8765
# http://localhost:8765                                   statewide
# http://localhost:8765/#c=Allegheny                      county
# http://localhost:8765/#m=4200361000                     municipality (Census GEOID)
# http://localhost:8765/?layers=para,stops#m=4200361000   with paratransit + GTFS stop overlays
```

There is no build step. The app uses Leaflet from cdnjs, OSM basemap tiles, and the Overpass API (with mirror fallback) for live OSM layer previews.

## Deployment and data refresh

- **GitHub Pages** deploys from the `main` branch (Settings → Pages → Deploy from a branch). The site is the repo root; `.nojekyll` makes Pages serve the files as-is, without Jekyll processing.
- **Weekly refresh:** `.github/workflows/refresh-data.yml` runs Mondays at 07:17 UTC (or manually from the Actions tab). It re-downloads the OSM extract and GTFS feeds, recomputes `data/*.json`, commits any changes and requests a Pages rebuild. Census boundaries are rebuilt only when it's run manually with **census** ticked. If Pages later deploys from another branch, point the workflow's checkout at that branch.

## Rebuilding the data locally

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

scripts/download_data.sh census                    # Census 2023 boundaries + 2020 population (TIGERweb, no key)
.venv/bin/python scripts/build_municipalities.py   # -> data/municipalities.geojson, data/counties.geojson

scripts/download_data.sh osm                       # Geofabrik PA extract (~350 MB)
.venv/bin/python scripts/osm_coverage.py           # -> data/osm_coverage.json (+ build/derived/osm_ped_geoms.pkl)

scripts/download_data.sh gtfs                      # Mobility Database catalog exports
.venv/bin/python scripts/fetch_gtfs.py             # -> build/raw/gtfs/feeds/*.zip (~140 MB)
.venv/bin/python scripts/transit_coverage.py       # -> data/transit_*.json, data/paratransit_ada.geojson
```

The transit step needs the OSM step's output (for the stop-to-sidewalk check). Raw downloads go to `build/`, which is gitignored.

## Files
- `data/catalog.json`: the dataset catalog. **All datasets except OSM are unverified candidates** and are left out of scores unless you tick "Include unverified" in the app. `coverage.municipalities` takes Census GEOIDs; `coverage.counties` takes county names.
- `data/schema.json`: the common accessibility attribute vocabulary (OSM/OpenSidewalks-aligned).
- `data/municipalities.geojson`, `data/counties.geojson`: simplified boundaries with 2020 population.
- `data/osm_coverage.json`: additive OSM metrics per municipality, so county and population-band totals are exact sums.
- `data/transit_feeds.json`, `data/transit_coverage.json`, `data/transit_stops.json`: GTFS feed audit (including each feed's source and license URL), per-municipality transit sums, and deduplicated stops (loaded only when the stop layer is shown).
- `data/paratransit_ada.geojson`: the **derived** minimum ADA paratransit area. It is not an official service area.
- `js/app.js`: views, coverage scoring (`osmLevels()` holds the thresholds), layer previews, schema inference and CSV export.
- `scripts/`: the data download and build scripts.

## Data sources and licenses

| Source | Used for | License / terms |
|---|---|---|
| **OpenStreetMap** contributors, via the [Geofabrik](https://download.geofabrik.de/north-america/us/pennsylvania.html) PA extract and the Overpass API | `data/osm_coverage.json`, stop-to-sidewalk check, live layer previews | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). `data/osm_coverage.json` is a derived database and is made available under the ODbL. © OpenStreetMap contributors. |
| OpenStreetMap standard tile layer | basemap | [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/): fine for light use; switch to a keyed provider if traffic grows. |
| **US Census Bureau**: 2023 cartographic boundary files, 2020 Census population (TIGERweb) | `data/municipalities.geojson`, `data/counties.geojson` | Public domain (US federal government work). |
| **Transit agency GTFS feeds** (49 feeds with PA stops), discovered via the [Mobility Database](https://mobilitydatabase.org) | `data/transit_*.json`, `data/paratransit_ada.geojson` | Per agency. Each feed's source URL and stated license link are recorded in `data/transit_feeds.json`. SEPTA, Pittsburgh Regional Transit and NJ Transit publish developer terms; most smaller agencies state none. Stop data is © the respective agencies and is provided here for research use. |
| Mobility Database catalog | feed discovery only | See [mobilitydatabase.org](https://mobilitydatabase.org). |

## Caveats
- **Coverage ≠ accessibility.** The dashboard measures whether *data* about an attribute exists, not whether the infrastructure is accessible.
- **OSM thresholds** (what counts as "partial" or "full") are uncalibrated placeholders; the planned calibration is in PLAN.md, Phase 2c.
- **Catalog candidates** (PennDOT, DVRPC, city datasets) are unverified assumptions and are excluded from scores by default.
- **Paratransit area** is the ADA minimum (49 CFR 37.131: ¾ mile around non-commuter fixed bus routes and rail stations), derived from GTFS. Agencies' actual service areas often differ.
- **GTFS freshness** depends on the Mobility Database catalog; some catalogued feeds are expired (flagged in the app).
