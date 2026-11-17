#!/usr/bin/env bash
# Download raw inputs into build/raw/. Usage: scripts/download_data.sh [census] [osm] [gtfs]  (default: all)
set -euo pipefail
cd "$(dirname "$0")/.."
targets=("$@"); [ ${#targets[@]} -eq 0 ] && targets=(census osm gtfs)
fetch() { curl -fsSL --retry 3 --retry-delay 5 -o "$1" "$2"; echo "  $(du -h "$1" | cut -f1)  $1"; }

for t in "${targets[@]}"; do
  case "$t" in
    census)
      mkdir -p build/raw/census
      fetch build/raw/census/cb_2023_42_cousub_500k.zip https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_42_cousub_500k.zip
      fetch build/raw/census/cb_2023_us_county_500k.zip https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip
      for off in 0 1000 2000; do
        fetch "build/raw/census/pop_$off.json" "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/20/query?where=STATE%3D%2742%27&outFields=GEOID,POP100&returnGeometry=false&resultOffset=$off&resultRecordCount=1000&f=json"
      done ;;
    osm)
      mkdir -p build/raw/osm
      fetch build/raw/osm/pennsylvania-latest.osm.pbf https://download.geofabrik.de/north-america/us/pennsylvania-latest.osm.pbf ;;
    gtfs)
      mkdir -p build/raw/gtfs
      fetch build/raw/gtfs/feeds_v2.csv https://files.mobilitydatabase.org/feeds_v2.csv
      fetch build/raw/gtfs/mdb_catalog.csv https://share.mobilitydata.org/catalogs-csv ;;
    *) echo "unknown target: $t" >&2; exit 1 ;;
  esac
done
