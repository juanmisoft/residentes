# -*- coding: utf-8 -*-
"""Localiza cada dirección en el portal de CartoCiudad, no en el centro de la parcela."""

import csv
import json
import re
import threading
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CSV_PATH = ROOT / "Padron_por_Portal_Piso_y_Puerta.csv"
COORDS_PATH = DATA / "coords_cache.json"
PORTAL_PATH = DATA / "portales_cache.json"
BBOX = {"lon_min": -3.68, "lon_max": -3.42, "lat_min": 40.26, "lat_max": 40.44}
WORKERS = 4


def norm_via(via):
    text = re.sub(r"\s*\([^)]*\)", " ", (via or "").upper())
    return re.sub(r"\s+", " ", text).strip()


def addresses_to_fetch():
    coords = {}
    if COORDS_PATH.exists():
        coords = json.load(COORDS_PATH.open(encoding="utf-8"))
    by = defaultdict(lambda: {"portals": set(), "vias": set()})
    missing = set()
    with CSV_PATH.open(encoding="latin1", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        for row in reader:
            rc = (row.get("ReferenciaCatastral") or "").strip()[:14]
            via = (row.get("VIA_NUMERO") or "").strip()
            portal = (row.get("PORTAL") or "").strip()
            if len(rc) < 14 or not via:
                continue
            by[rc]["vias"].add(via)
            if portal:
                by[rc]["portals"].add(portal)
            if rc not in coords:
                missing.add(norm_via(via))
    multi = set()
    for info in by.values():
        if len(info["portals"]) >= 2:
            multi.update(norm_via(via) for via in info["vias"] if via)
    return {via for via in (missing | multi) if via}


def load_portales():
    if not PORTAL_PATH.exists():
        return {}
    data = json.load(PORTAL_PATH.open(encoding="utf-8"))
    return data.get("ok", data) if isinstance(data, dict) and "ok" in data else data


def save_portales(found, failed):
    tmp = PORTAL_PATH.with_suffix(".tmp.json")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump({"ok": found, "fail": sorted(failed)}, handle, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(PORTAL_PATH)


def geocode(via):
    query = urllib.parse.quote(via + ", Rivas-Vaciamadrid")
    url = (
        "https://www.cartociudad.es/geocoder/api/geocoder/find?type=portal&limit=1&q="
        + query
    )
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "RivasPadron3D/1.0"})
            with urllib.request.urlopen(req, timeout=12) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            if not isinstance(payload, dict):
                return via, None
            muni = (payload.get("muni") or "").lower()
            if "rivas" not in muni:
                return via, None
            lon = float(payload["lng"])
            lat = float(payload["lat"])
            if not (BBOX["lon_min"] <= lon <= BBOX["lon_max"] and BBOX["lat_min"] <= lat <= BBOX["lat_max"]):
                return via, None
            return via, [round(lon, 7), round(lat, 7)]
        except Exception:
            time.sleep(0.4 * (attempt + 1))
    return via, None


def main():
    needed = addresses_to_fetch()
    found = load_portales()
    if isinstance(found, dict) and "fail" in found:
        found = found.get("ok", {})
    failed = set()
    pending = [via for via in sorted(needed) if via not in found]
    print(f"Portales a consultar: {len(pending)} (ya guardados {len(found)})", flush=True)
    if not pending:
        return
    lock = threading.Lock()
    done = 0

    def mark(via, coord):
        nonlocal done
        with lock:
            done += 1
            if coord:
                found[via] = coord
            else:
                failed.add(via)
            if done % 100 == 0 or done == len(pending):
                save_portales(found, failed)
                print(f"  {done}/{len(pending)}  localizados: {len(found)}", flush=True)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(geocode, via) for via in pending]
        for fut in as_completed(futures):
            via, coord = fut.result()
            mark(via, coord)
    save_portales(found, failed)
    print(f"Listo. Portales: {len(found)}  sin localizar: {len(failed)}", flush=True)


if __name__ == "__main__":
    main()
