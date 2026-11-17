"""Discover and download GTFS static feeds that serve Pennsylvania.

Discovery: Mobility Database catalog exports (no API key needed):
  - build/raw/gtfs/feeds_v2.csv      https://files.mobilitydatabase.org/feeds_v2.csv
  - build/raw/gtfs/mdb_catalog.csv   https://share.mobilitydata.org/catalogs-csv  (legacy; fills gaps)
A feed is selected if it is active and tagged Pennsylvania, or its bounding-box center lies in PA.
Feeds from neighbouring states are kept: stops outside PA are dropped later by the spatial join.

Output: build/raw/gtfs/feeds/<id>.zip and build/raw/gtfs/manifest.json
"""
import csv
import json
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "build" / "raw" / "gtfs"
FEEDS = RAW / "feeds"
PA_BOX = (39.72, 42.27, -80.52, -74.69)


def in_pa(r):
    if r.get("location.subdivision_name") == "Pennsylvania":
        return True
    try:
        la = (float(r["location.bounding_box.minimum_latitude"]) + float(r["location.bounding_box.maximum_latitude"])) / 2
        lo = (float(r["location.bounding_box.minimum_longitude"]) + float(r["location.bounding_box.maximum_longitude"])) / 2
    except (KeyError, ValueError):
        return False
    return PA_BOX[0] < la < PA_BOX[1] and PA_BOX[2] < lo < PA_BOX[3]


def select():
    chosen = {}
    for r in csv.DictReader(open(RAW / "feeds_v2.csv")):
        if r["data_type"] == "gtfs" and r["status"] not in ("deprecated", "inactive") and in_pa(r) and r["urls.latest"]:
            chosen[r["id"]] = r
    providers = {r["provider"].lower() for r in chosen.values()}
    legacy = RAW / "mdb_catalog.csv"
    if legacy.exists():
        for r in csv.DictReader(open(legacy)):
            rid = f"mdb-{r['mdb_source_id']}"
            if (r["data_type"] == "gtfs" and r["status"] != "deprecated" and in_pa(r) and r["urls.latest"]
                    and rid not in chosen and r["provider"].lower() not in providers):
                chosen[rid] = {**r, "id": rid}
    return chosen


def main():
    FEEDS.mkdir(parents=True, exist_ok=True)
    feeds = select()
    manifest = []
    for fid, r in sorted(feeds.items()):
        dest = FEEDS / f"{fid}.zip"
        status = "cached"
        if not dest.exists():
            try:
                req = urllib.request.Request(r["urls.latest"], headers={"User-Agent": "pa-ped-coverage/0.1"})
                with urllib.request.urlopen(req, timeout=180) as resp:
                    dest.write_bytes(resp.read())
                status = "downloaded"
            except Exception as e:  # keep going; record failure in manifest
                status = f"failed: {e}"
            time.sleep(0.3)
        manifest.append({
            "id": fid, "provider": r["provider"], "name": r.get("name", ""),
            "subdivision": r.get("location.subdivision_name", ""), "url": r["urls.latest"],
            "producer_url": r.get("urls.direct_download", ""), "license": r.get("urls.license", ""),
            "status": status, "fetched": date.today().isoformat(),
            "bytes": dest.stat().st_size if dest.exists() else 0,
        })
        print(f"{fid:12} {status:12} {r['provider'][:60]}")
    (RAW / "manifest.json").write_text(json.dumps(manifest, indent=1))
    failed = [m for m in manifest if m["status"].startswith("failed")]
    print(f"{len(manifest)} feeds, {len(failed)} failed")
    if failed:
        sys.exit(0)


if __name__ == "__main__":
    main()
