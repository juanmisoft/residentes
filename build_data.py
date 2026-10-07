# -*- coding: utf-8 -*-
"""Prepara el padrón para el visor 3D.

La XY de cada parcela sale del servicio oficial de coordenadas del Catastro.
La Z y la separación entre letras se calculan aquí: no hay cota ni planta
en la geometría catastral. El volumen del edificio lo pone el modelo 3D de OSM.
"""

import argparse
import csv
import json
import math
import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

CSV_PATH = ROOT / "Padron_por_Portal_Piso_y_Puerta.csv"
CACHE_PATH = DATA / "coords_cache.json"
PORTAL_PATH = DATA / "portales_cache.json"
SEED_PATH = Path(
    r"g:\Mi unidad\PROYECTOS\Proyectos Personalización ARCGIS"
    r"\Residentes por Viviendas\coords_cache.json"
)

# Margen holgado alrededor del término. Fuera de aquí la coordenada no se usa.
BBOX = {"lon_min": -3.68, "lon_max": -3.42, "lat_min": 40.26, "lat_max": 40.44}
FLOOR_HEIGHT = 3.0
MAX_ROW_WIDTH = 16.0
BASE_SPACING = 3.0
NS = {"c": "http://www.catastro.meh.es/"}
WORKERS = 8


def parse_planta(piso):
    p = (piso or "").strip().upper()
    if not p:
        return None
    if p in {"PBJ", "P00", "PB", "BAJO", "BJ", "0", "P0", "00"}:
        return 0
    if p.startswith("P") and p[1:].isdigit():
        return int(p[1:])
    if p.lstrip("-").isdigit():
        return int(p)
    if "SOT" in p or "SEM" in p or p.startswith("SS"):
        return -1
    return None


def planta_txt(planta, unica):
    if planta is None:
        return "Unifamiliar" if unica else "Sin planta"
    if planta < 0:
        return "Sótano"
    if planta == 0:
        return "Baja"
    return f"{planta}.ª"


def z_for(planta):
    if planta is None:
        return FLOOR_HEIGHT * 0.5
    if planta < 0:
        return 0.6
    return (planta + 0.5) * FLOOR_HEIGHT


def rc14_of(referencia):
    return (referencia or "").strip()[:14]


def load_cache():
    cache = {}
    if SEED_PATH.exists():
        with SEED_PATH.open(encoding="utf-8") as f:
            cache.update(json.load(f))
    if CACHE_PATH.exists():
        with CACHE_PATH.open(encoding="utf-8") as f:
            cache.update(json.load(f))
    return cache


def save_cache(cache):
    tmp = CACHE_PATH.with_suffix(".tmp.json")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, separators=(",", ":"))
    tmp.replace(CACHE_PATH)


def fetch_coord(rc):
    url = (
        "https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/"
        f"OVCCoordenadas.asmx/Consulta_CPMRC?Provincia=&Municipio=&SRS=EPSG:4326&RC={rc}"
    )
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "RivasPadron3D/1.0"})
            with urllib.request.urlopen(req, timeout=12) as resp:
                root = ET.fromstring(resp.read())
            err = root.find(".//c:cuerr", NS)
            if err is not None and (err.text or "0") not in {"0"}:
                return rc, None
            x = root.find(".//c:xcen", NS)
            y = root.find(".//c:ycen", NS)
            if x is None or y is None or not x.text or not y.text:
                return rc, None
            lon, lat = float(x.text), float(y.text)
            if not (BBOX["lon_min"] <= lon <= BBOX["lon_max"] and BBOX["lat_min"] <= lat <= BBOX["lat_max"]):
                return rc, None
            return rc, [round(lon, 7), round(lat, 7)]
        except Exception:
            time.sleep(0.35 * (attempt + 1))
    return rc, None


def fill_cache(cache, needed):
    if not needed:
        print("Caché de coordenadas completa.")
        return cache
    print(f"Consultando Catastro: {len(needed)} parcelas…")
    lock = threading.Lock()
    done = 0
    found = 0

    def mark(rc, coord):
        nonlocal done, found
        with lock:
            done += 1
            if coord:
                cache[rc] = coord
                found += 1
            if done % 250 == 0 or done == len(needed):
                save_cache(cache)
                print(f"  {done}/{len(needed)}  con coordenada nueva: {found}")

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(fetch_coord, rc) for rc in needed]
        for fut in as_completed(futures):
            rc, coord = fut.result()
            mark(rc, coord)
    save_cache(cache)
    return cache


def load_rows():
    rows = []
    seen = set()
    with CSV_PATH.open(encoding="latin1", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        for i, row in enumerate(reader):
            ref = (row.get("ReferenciaCatastral") or "").strip()
            rc = rc14_of(ref)
            if len(rc) < 14:
                continue
            via = (row.get("VIA_NUMERO") or "").strip()
            portal = (row.get("PORTAL") or "").strip()
            piso = (row.get("PISO") or "").strip()
            letra = (row.get("PUERTA") or "").strip()
            try:
                hab = int((row.get("HABITANTES") or "0").strip() or 0)
            except ValueError:
                hab = 0
            key = (ref, portal, piso, letra, hab)
            if key in seen:
                continue
            seen.add(key)
            rows.append(
                {
                    "id": i,
                    "rc": rc,
                    "ref": ref,
                    "via": via,
                    "portal": portal,
                    "piso": piso,
                    "planta": parse_planta(piso),
                    "letra": letra,
                    "hab": hab,
                }
            )
    return rows


def norm_via(via):
    text = re.sub(r"\s*\([^)]*\)", " ", (via or "").upper())
    return re.sub(r"\s+", " ", text).strip()


def load_portales():
    if not PORTAL_PATH.exists():
        return {}
    data = json.load(PORTAL_PATH.open(encoding="utf-8"))
    if isinstance(data, dict) and "ok" in data:
        return data["ok"]
    return data if isinstance(data, dict) else {}


def place(group):
    """Misma letra, misma XY en todas las plantas. Separación corta dentro del portal."""
    slots = []
    slot_index = {}
    ordered = sorted(group, key=lambda r: (r["portal"], r["letra"], r["planta"] is None, r["planta"] or 0, r["id"]))
    for row in ordered:
        key = (row["portal"], row["letra"])
        if key not in slot_index:
            slot_index[key] = len(slots)
            slots.append(key)
    n = len(slots)
    if n <= 1:
        spacing = 0.0
    else:
        spacing = min(BASE_SPACING, MAX_ROW_WIDTH / (n - 1))
    origin = -((n - 1) * spacing) / 2.0
    dup = Counter()
    placed = []
    for row in ordered:
        key = (row["portal"], row["letra"])
        floor_key = (row["portal"], row["letra"], row["planta"])
        dup[floor_key] += 1
        east = origin + slot_index[key] * spacing
        north = (dup[floor_key] - 1) * 2.2
        placed.append((row, east, north))
    return placed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-fetch", action="store_true")
    args = parser.parse_args()

    rows = load_rows()
    by_rc = defaultdict(list)
    for row in rows:
        by_rc[row["rc"]].append(row)
    print(f"Viviendas: {len(rows)}  Parcelas: {len(by_rc)}", flush=True)

    cache = load_cache()
    if args.no_fetch:
        print(f"Sin consulta al Catastro. Coordenadas en caché: {len(cache)}", flush=True)
    else:
        needed = [rc for rc in by_rc if rc not in cache]
        cache = fill_cache(cache, needed)

    portales = load_portales()
    print(f"Portales localizados: {len(portales)}", flush=True)
    m_lat = 1.0 / 111139.0
    features = []
    edificios = []
    skipped_rows = 0
    ejemplo = None

    def row_anchor(row, fallback):
        hit = portales.get(norm_via(row["via"]))
        if hit and len(hit) == 2:
            return float(hit[0]), float(hit[1])
        return fallback

    def in_bbox(lon, lat):
        return BBOX["lon_min"] <= lon <= BBOX["lon_max"] and BBOX["lat_min"] <= lat <= BBOX["lat_max"]

    for rc, group in by_rc.items():
        fallback = None
        cached = cache.get(rc)
        if cached and len(cached) == 2:
            fallback = (float(cached[0]), float(cached[1]))
        by_portal = defaultdict(list)
        for row in group:
            by_portal[row["portal"] or ""].append(row)

        portal_sites = []
        for portal_name, portal_rows in by_portal.items():
            coords = []
            for row in portal_rows:
                anchor = row_anchor(row, fallback)
                if anchor and in_bbox(*anchor):
                    coords.append(anchor)
            if not coords:
                continue
            lon = sum(c[0] for c in coords) / len(coords)
            lat = sum(c[1] for c in coords) / len(coords)
            portal_sites.append([portal_name, lon, lat, portal_rows])

        if not portal_sites:
            skipped_rows += len(group)
            continue

        mean_lon = sum(site[1] for site in portal_sites) / len(portal_sites)
        mean_lat = sum(site[2] for site in portal_sites) / len(portal_sites)
        m_lon = 1.0 / (111139.0 * math.cos(math.radians(mean_lat)))
        spread = len(portal_sites) > 1 and all(
            math.hypot((site[1] - mean_lon) / m_lon, (site[2] - mean_lat) / m_lat) < 12
            for site in portal_sites
        )
        if spread:
            count = len(portal_sites)
            radius = min(28.0, 4.0 / math.sin(math.pi / count))
            for index, site in enumerate(portal_sites):
                angle = 2 * math.pi * index / count
                site[1] = mean_lon + radius * math.cos(angle) * m_lon
                site[2] = mean_lat + radius * math.sin(angle) * m_lat

        unica = len(group) == 1
        vias = Counter(r["via"] for r in group if r["via"])
        direccion = " · ".join(v for v, _ in vias.most_common(3)) or "Sin dirección"
        residentes = sum(r["hab"] for r in group)
        sample = group[0]
        edificios.append(
            {
                "rc": rc,
                "lon": round(mean_lon, 7),
                "lat": round(mean_lat, 7),
                "direccion": direccion,
                "viviendas": len(group),
                "residentes": residentes,
                "tipo": "unifamiliar" if unica else "plurifamiliar",
                "planta": planta_txt(sample["planta"], True) if unica else "",
                "letra": sample["letra"] if unica else "",
            }
        )
        if ejemplo is None or len(group) > ejemplo["viviendas"]:
            ejemplo = edificios[-1]

        for _portal_name, lon, lat, portal_rows in portal_sites:
            site_m_lon = 1.0 / (111139.0 * math.cos(math.radians(lat)))
            for row, east, north in place(portal_rows):
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "Point",
                            "coordinates": [
                                round(lon + east * site_m_lon, 7),
                                round(lat + north * m_lat, 7),
                                round(z_for(row["planta"]), 2),
                            ],
                        },
                        "properties": {
                            "id": row["id"],
                            "rc": rc,
                            "direccion": row["via"] or direccion,
                            "planta": planta_txt(row["planta"], unica),
                            "letra": row["letra"],
                            "residentes": row["hab"],
                            "tipo": "unifamiliar" if unica else "plurifamiliar",
                        },
                    }
                )

    geojson = {"type": "FeatureCollection", "features": features}
    with (DATA / "viviendas.geojson").open("w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, separators=(",", ":"))
    with (DATA / "edificios.json").open("w", encoding="utf-8") as f:
        json.dump(edificios, f, ensure_ascii=False, separators=(",", ":"))

    lons = [b["lon"] for b in edificios]
    lats = [b["lat"] for b in edificios]
    center = [round(sum(lons) / len(lons), 6), round(sum(lats) / len(lats), 6)] if edificios else [-3.53, 40.35]
    meta = {
        "viviendas": len(features),
        "edificios": len(edificios),
        "sin_coordenada": skipped_rows,
        "center": center,
        "ejemplo": {
            "lon": ejemplo["lon"],
            "lat": ejemplo["lat"],
            "direccion": ejemplo["direccion"],
            "viviendas": ejemplo["viviendas"],
            "residentes": ejemplo["residentes"],
        }
        if ejemplo
        else None,
    }
    with (DATA / "meta.json").open("w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
