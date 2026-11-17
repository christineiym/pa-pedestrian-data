# PA pedestrian accessibility data coverage dashboard: plan

## Goal

Show **where machine-readable pedestrian accessibility data exists in Pennsylvania, who publishes it, and what it actually contains**. The aim is to make fragmentation across state, regional, county, municipal and crowdsourced sources visible and measurable.

**Audience:** researchers and planners. Scores therefore default to verified or measured sources only, every number can be exported as CSV, and the method is documented below.

### Questions the dashboard should answer
1. For a given municipality: which accessibility attributes (sidewalks, curb ramps, slope, and so on) are covered, and by which source?
2. Statewide, by county, and by municipality size: where are the gaps, and which attributes are systematically missing?
3. For a dataset: what is its schema, how complete are its fields, and how does it map to a common standard?
4. How much of the data is locked in non-machine-readable formats (PDF ADA transition plans, reports)?

## Data model

| Entity | Key fields | Source |
|---|---|---|
| **Municipality** | Census county-subdivision GEOID, name, type (city / borough / township / town / home-rule municipality), county, 2020 population, area | `data/municipalities.geojson` (Census cartographic boundaries, 2023, plus TIGERweb 2020 POP100) |
| **County** | name, FIPS code, population, number of municipalities | `data/counties.geojson` |
| **Dataset** | publisher, level (state / regional / county / municipal / crowd), format, license, endpoint, coverage extent (statewide / counties / municipality GEOIDs), `verified`, `machineReadable` | `data/catalog.json` |
| **Attribute** | the common vocabulary of 10 accessibility attributes, each with an OSM/OpenSidewalks equivalent and field-name hints | `data/schema.json` |
| **Coverage** | dataset × attribute → level 0/1/2 (none/partial/full), declared or measured | declared in the catalog; OSM measured per municipality (`data/osm_coverage.json`) |

**Municipality coverage score** = for each attribute, the best level across all applicable machine-readable datasets; score = Σ levels / (2 × #attributes). Attributes are deliberately **unweighted** for now.
Unverified catalog entries are **excluded by default**. A toggle includes them as dashed "assumed" cells, so it is always visible which numbers rest on assumptions.

**Group aggregates** (county, population band, type) are population-weighted: the share of the group's population living in municipalities where an attribute is at least partial (and the share where it is full), plus the population-weighted mean score. OSM metrics are stored as additive sums, so county-level OSM ratios are exact rather than averages of ratios.

Population bands: < 1k, 1k–2.5k, 2.5k–5k, 5k–10k, 10k–25k, 25k–100k, 100k+.

### OSM measurement method
`scripts/osm_coverage.py` reads the statewide Geofabrik extract and assigns each way to the municipality containing its middle node, and each node to the municipality containing it. Thresholds are in `osmLevels()` in `js/app.js`:
- **Sidewalks:** (separately mapped sidewalk length + street length implied by `sidewalk=both|left|right`) / (2 × street length, primary through residential). ≥60% counts as full, >5% as partial.
- **Crossings:** crossings per street-km. ≥3 counts as full, >0.2 as partial.
- **Curb ramps:** kerb-tagged nodes / (2 × crossing nodes).
- **Width / surface / incline / condition:** the share of sidewalk ways carrying `width` / `surface` / `incline` / `smoothness`.
- **Tactile paving:** the share of crossings and kerbs with `tactile_paving`. **APS:** the share of signalized crossings with `traffic_signals:sound`.
- **Steps:** present or absent.
- **Transit stops** (`highway=bus_stop`, `public_transport=platform`, rail platforms and stations): counts and `wheelchair` / `tactile_paving` / `shelter` / `bench` tagging. These are reported and mappable but not scored.

Known limitations: thresholds are placeholders to be calibrated against known-complete inventories. Midpoint assignment splits long ways crudely at boundaries. "Partial" for a tag share can mean a single tagged way.

First statewide run (2026-11-17 extract): 13,450 km of mapped sidewalks against 219,000 km of streets. Only 235 sidewalk ways carry `width` and 97 carry `incline`. OSM has 6,463 transit stops statewide, against 37,153 in agency GTFS feeds, so GTFS is the primary transit source (Phase 2b).

## Prototype scope (done)
- **Statewide view:** KPI tiles; a coverage matrix grouped by **county, population band or municipality type**, with expandable groups and municipality rows; search across all 2,572 municipalities; CSV export; and a dataset catalog filterable by level.
- **Map:** a municipality choropleth (overall score, any single attribute, or fixed-route transit measures) with county outlines and an optional derived ADA paratransit overlay.
- **Drill path:** state → county (`#c=Allegheny`) → municipality (`#m=<GEOID>`), with breadcrumbs.
- **Municipality view:** per-attribute coverage with sources, the OSM measurement table, live OSM layer preview (sidewalks, crossings, kerbs, steps, stops), datasets covering the municipality, and ad-hoc ArcGIS/GeoJSON preview by URL.
- **Schema view:** dataset metadata, a crosswalk to the common attributes, declared fields (ArcGIS), and an inferred schema (fill rate, examples, guessed mapping).

## Next phases

### Phase 1: verify and expand the catalog
- Verify each candidate in `catalog.json` (all except OSM are unverified). Record the real endpoint, license, vintage and field list, then set `verified: true`.
- Systematically harvest portals rather than relying on manual entry. Most PA publishers use a few platforms:
  - ArcGIS Hub / Online (PennDOT, many counties): use the Hub search API or `…/arcgis/rest/services?f=json`.
  - CKAN (WPRDC): `package_search` API.
  - PASDA (pasda.psu.edu), the state clearinghouse: its catalog.
  - Socrata / Carto / one-off municipal sites.
- Use keyword plus field-name matching (`field_hints`) to flag candidate pedestrian datasets automatically, then review them by hand.
- Track non-machine-readable sources, such as ADA transition plans, as their own records so the "locked in PDF" share is measurable.

### Phase 2: real geography (mostly done)
- ~~Municipal polygons, choropleth, and state → county → municipality drill path~~ (done).
- ~~Statewide OSM precompute over actual boundaries~~ (done; `scripts/osm_coverage.py`). Next: run it on a schedule (for example weekly) and keep snapshots so change over time is visible.
- Optional: block-group level for large cities, where a single municipal score hides large internal variation (for example Philadelphia).

### Phase 2b: transit and multimodal extracts
Pedestrian access matters most where it connects to transit. Accessible routes are only useful if they reach accessible stops, and vice versa. **Scope decision:** regular fixed-route service first, plus a paratransit coverage-area layer.

**Done (fixed-route, first pass)**
- `scripts/fetch_gtfs.py` discovers feeds through the Mobility Database catalog exports (`feeds_v2.csv`, with the legacy catalog filling gaps; no API key). It found 57 feeds, 49 of which have stops in PA.
- `scripts/transit_coverage.py` produces:
  - a per-feed audit of `stops.wheelchair_boarding` (inherited from parent stations per the GTFS spec), `trips.wheelchair_accessible`, `pathways.txt`, `levels.txt` and service end date;
  - stops deduplicated across feeds (~1 m), joined to municipalities;
  - a stop-to-sidewalk check: whether each stop is within 20 m of an OSM sidewalk, crossing, or street tagged `sidewalk=*`.
- **Derived ADA paratransit area:** ¾ mile around non-commuter fixed bus routes (from GTFS shapes, or stop sequences as a fallback) and around light-rail/subway stations, per 49 CFR 37.131. Commuter rail, intercity coach and demand-response routes are excluded. Commuter *bus* is also exempt but can't be identified from GTFS. The result is the **minimum required** area, not any agency's official service area; agencies often serve more.
- **Dashboard:** KPIs, a feeds × accessibility-fields table, map color options (wheelchair_boarding share, stops near a sidewalk, share of area in the paratransit zone), a stop layer colored by `wheelchair_boarding`, a paratransit overlay (`?layers=para,stops` to share), and transit columns in the CSV export.

**First findings (2026-11-17)**
- 37,153 unique stops in PA. 37% have `wheelchair_boarding` specified, and nearly all of those are SEPTA's. Pittsburgh Regional Transit (6,353 PA stops) populates trip-level `wheelchair_accessible` but leaves stop-level `wheelchair_boarding` empty. No other PA agency populates either at stop level.
- SEPTA is the only PA feed with `pathways.txt` / `levels.txt`.
- 50% of stops are within 20 m of a mapped OSM sidewalk or crossing (Philadelphia 79%).
- The only Erie (EMTA) feed in the catalog expired in 2023. Other feeds may be stale in the catalog even where the agency publishes current data; check the producer URLs.

**Next (transit)**
- **Official paratransit areas:** ask agencies and PennDOT for service-area GIS. Where only PDFs exist, catalog them as non-machine-readable records and compare their area with the derived minimum.
- Flag commuter-bus routes manually (a small list per agency) so they're excluded from the derived area.
- Agreement between GTFS `wheelchair_boarding` and OSM `wheelchair` tags on matched stops, as a data-quality signal.
- **Accessible-stop access:** the share of population within a 400 m / 800 m network walk of a stop marked accessible. This needs the Phase 3 network and block-level population.
- Population (not just area) inside the paratransit zone, using census blocks.
- **Later:** GTFS-Realtime elevator alerts; PennDOT shared-ride / GTFS-Flex; bikeshare and scooter data (GBFS: Indego, POGOH); Amtrak stations.

### Phase 2c: calibrating against sample audits (Pittsburgh and Philadelphia)
No PA jurisdiction is known to have a complete inventory, so calibrate against a **sample audit** instead of a full ground truth:
1. **Sample:** draw a stratified random sample of street segments in Pittsburgh and Philadelphia (strata: downtown / urban residential / low-density; ~100–200 segments per city), plus a matched sample of crossings.
2. **Annotate:** record presence per segment side (sidewalk, curb ramp at each crossing end, and where visible width class, surface, tactile paving) from street-level imagery. Project Sidewalk's Pittsburgh labels, if confirmed (Phase 1), can stand in for part of this.
3. **Compare:** for each attribute, estimate OSM's recall and precision against the audit, then set the partial/full thresholds in `osmLevels()` so that "full" means the OSM data reflects at least ~X% of what exists. Report confidence intervals, since this is a sample.
4. **Transfer:** these two cities are not representative of boroughs and townships. Add a small audit of 2–3 lower-density municipalities before applying the thresholds statewide.
5. **Use city data where it exists:** verifying the Philadelphia and Pittsburgh catalog candidates (Phase 1) also yields a second, independent source to compare OSM against.

### Phase 3: schema crosswalk
- Store explicit field mappings per dataset (for example `SW_WIDTH → width (ft → m)`), editable in the UI, replacing the regex guesses.
- Target the **OpenSidewalks** schema as the interchange format so that harmonized exports become possible.
- Add a quality dimension (vintage, completeness, positional accuracy) beside presence and absence.

### Phase 4: hardening
- Move from a static site to a small build (for example Vite plus MapLibre with vector tiles) once the data volume requires it.
- Use a keyed basemap provider: OSM's public tiles are fine for prototyping but not for production traffic.
- Cache layer previews, and proxy endpoints that lack CORS.

## Decisions and open questions
- **Ground truth:** no complete inventory is known. Calibrate with sample audits in Pittsburgh and Philadelphia (Phase 2c).
- **Weighting:** deferred. Attributes count equally for now.
- **Transit scope:** fixed-route first, plus a paratransit coverage layer (derived for now; official areas where obtainable).
- **Open:** how big should the audit sample be, and who annotates it (in-house, students, or Project Sidewalk-style crowd work)?
