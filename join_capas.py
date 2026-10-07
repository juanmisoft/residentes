# -*- coding: utf-8 -*-
"""Une el padrón con las parcelas y los portales del servidor de Rivas."""

import csv
import json
import math
import re
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
CSV_PATH = ROOT / "Padron_por_Portal_Piso_y_Puerta.csv"

PORTALES = "https://sit.rivasciudad.es/server/rest/services/ACCESOS_PORTALES/FeatureServer/0/query"
PARCELAS = "https://sit.rivasciudad.es/server/rest/services/PARCELAS_CATASTRALES_URBANA/FeatureServer/0/query"

FLOOR_HEIGHT = 3.0
PAGE = 2000


def get(url, params):
    params = dict(params)
    params["f"] = "json"
    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def catastro_coord(rc):
    """Centroide público de Catastro. No incluye datos del titular."""
    url = "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCoordenadas.svc/json/Consulta_CPMRC"
    try:
        data = get(url, {"RefCat": rc, "SRS": "EPSG:4326"})
    except Exception as exc:
        print(f"  catastro {rc}: {exc}", flush=True)
        return None
    coords = (((data.get("Consulta_CPMRCResult") or {}).get("coordenadas") or {}).get("coord") or [])
    if not coords:
        return None
    geo = coords[0].get("geo") or {}
    try:
        lon = float(geo["xcen"])
        lat = float(geo["ycen"])
    except (KeyError, TypeError, ValueError):
        return None
    return {"lon": lon, "lat": lat, "ldt": coords[0].get("ldt") or ""}


def catastro_lookup(rc, street):
    """Si la parcela no está en las capas municipales, usa el centroide de Catastro.

    Algunas referencias del padrón traen un 5 donde la hoja catastral lleva S.
    Solo se acepta ese cambio si la dirección devuelta coincide con la del padrón.
    """
    found = catastro_coord(rc)
    if found:
        return found, rc
    if len(rc) == 14 and rc.endswith("5"):
        alt = rc[:-1] + "S"
        alt_found = catastro_coord(alt)
        token = norm_street(street)
        place = norm_street((alt_found or {}).get("ldt") or "")
        if alt_found and token and (token in place or place in token):
            return alt_found, alt
    return None


def paged(url, params):
    offset = 0
    while True:
        query = dict(params)
        query["resultOffset"] = offset
        query["resultRecordCount"] = PAGE
        data = get(url, query)
        if data.get("error"):
            raise RuntimeError(data["error"])
        batch = data.get("features", [])
        print(f"  {offset + len(batch)}", flush=True)
        for feature in batch:
            yield feature
        if not data.get("exceededTransferLimit") or not batch:
            break
        offset += len(batch)


def norm_street(text):
    text = re.sub(r"\s*\([^)]*\)", " ", (text or "").upper())
    text = re.sub(r"^(CALLE|CL|AVDA|AVENIDA|AV|PLAZA|PZ|PASEO|PS|GLORIETA|GT|CARRETERA|CTRA|CAMINO|CM|TRAVESIA|TRVA)\s+", "", text)
    text = re.sub(r"\s+\d+\s*$", "", text)
    text = re.sub(r"[^A-Z0-9 ]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def street_number(text):
    match = re.search(r"(\d+)\s*$", (text or "").strip())
    if not match:
        return ""
    return str(int(match.group(1)))


def parse_planta(piso):
    value = (piso or "").strip().upper()
    if not value:
        return None
    if value in {"PBJ", "P00", "PB", "BAJO", "BJ", "0", "P0", "00"}:
        return 0
    if value.startswith("P") and value[1:].isdigit():
        return int(value[1:])
    if value.lstrip("-").isdigit():
        return int(value)
    if "SOT" in value or "SEM" in value or value.startswith("SS"):
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


def load_portales():
    print("Portales…", flush=True)
    by_rc = defaultdict(list)
    for feature in paged(PORTALES, {
        "where": "REFCATASTRAL IS NOT NULL AND REFCATASTRAL <> 'SIN UBICACION PRECISA'",
        "outFields": "REFCATASTRAL,ACCESO,CALLE,ACRDESACC",
        "returnGeometry": "true",
        "outSR": "4326",
    }):
        attrs = feature.get("attributes") or {}
        geom = feature.get("geometry") or {}
        rc = (attrs.get("REFCATASTRAL") or "").strip()
        if len(rc) < 14 or "x" not in geom:
            continue
        by_rc[rc[:14]].append({
            "lon": geom["x"],
            "lat": geom["y"],
            "acceso": street_number(str(attrs.get("ACCESO") or "")),
            "calle": norm_street(attrs.get("CALLE") or ""),
            "rotulo": (attrs.get("ACRDESACC") or "").strip(),
        })
    print(f"  parcelas con portal: {len(by_rc)}", flush=True)
    return by_rc


def load_centroids():
    print("Centroides de parcela…", flush=True)
    centroids = {}
    for feature in paged(PARCELAS, {
        "where": "REFCAT IS NOT NULL",
        "outFields": "REFCAT",
        "returnGeometry": "false",
        "returnCentroid": "true",
        "outSR": "4326",
    }):
        attrs = feature.get("attributes") or {}
        center = feature.get("centroid") or {}
        rc = (attrs.get("REFCAT") or "").strip()[:14]
        if len(rc) < 14 or "x" not in center:
            continue
        centroids[rc] = (center["x"], center["y"])
    print(f"  parcelas: {len(centroids)}", flush=True)
    return centroids


def load_rows():
    rows = []
    seen = set()
    with CSV_PATH.open(encoding="latin1", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        for index, row in enumerate(reader):
            ref = (row.get("ReferenciaCatastral") or "").strip()
            rc = ref[:14]
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
            rows.append({
                "id": index,
                "rc": rc,
                "ref": ref,
                "via": via,
                "calle": norm_street(via),
                "numero": street_number(via),
                "portal": portal,
                "planta": parse_planta(piso),
                "letra": letra,
                "hab": hab,
            })
    return rows


def choose_portal(portals, row):
    if not portals:
        return None
    if len(portals) == 1:
        return portals[0]
    by_number = [portal for portal in portals if row["numero"] and portal["acceso"] == row["numero"]]
    if row["calle"]:
        named = [portal for portal in by_number if row["calle"] in portal["calle"] or portal["calle"] in row["calle"]]
        if len(named) == 1:
            return named[0]
        if named:
            by_number = named
    if len(by_number) == 1:
        return by_number[0]
    if by_number:
        return by_number[0]
    return None


def portal_anchor(portals, portal_name, used):
    """Si varios portales del padrón comparten el mismo punto, sepáralos unos metros."""
    if portal_name in used:
        return used[portal_name]
    return None


def main():
    portales = load_portales()
    centroids = load_centroids()
    rows = load_rows()
    by_rc = defaultdict(list)
    for row in rows:
        by_rc[row["rc"]].append(row)
    print(f"Viviendas {len(rows)}  parcelas padrón {len(by_rc)}", flush=True)

    features = []
    edificios = []
    sin_portal = 0
    sin_parcela = 0
    m_lat = 1.0 / 111139.0

    for rc, group in by_rc.items():
        portals = portales.get(rc, [])
        centroid = centroids.get(rc)
        if not portals and not centroid:
            located = catastro_lookup(rc, group[0]["via"] if group else "")
            if not located:
                sin_parcela += len(group)
                continue
            point, corrected = located
            fixed = corrected != rc
            if fixed:
                for row in group:
                    if (row.get("ref") or "").startswith(rc):
                        row["ref"] = corrected + row["ref"][len(rc):]
                    row["rc"] = corrected
                rc = corrected
            centroid = (point["lon"], point["lat"])
            note = "Incidencia: sin portal. Situada con la coordenada catastral."
            if fixed:
                note += " Referencia corregida."
            for row in group:
                row["incidencia"] = note
        unica = len(group) == 1
        # Un punto de anclaje por portal del padrón (Por. 01, Por. 02…).
        groups = defaultdict(list)
        for row in group:
            # El número de calle distingue las casas. Si se agrupa solo por PORTAL,
            # las que lo traen vacío comparten un único acceso y se estiran en línea.
            groups[(row["portal"] or "", row["numero"], row["calle"])].append(row)

        portal_names = sorted(groups)
        assigned = {}
        number_hits = {}
        for name, portal_rows in groups.items():
            sample = portal_rows[0]
            chosen = choose_portal(portals, sample)
            if chosen:
                number_hits.setdefault((round(chosen["lon"], 6), round(chosen["lat"], 6)), []).append(name)
                assigned[name] = chosen
            else:
                sin_portal += len(portal_rows)

        # Portales del padrón que caen en el mismo acceso real se separan poco, alrededor de ese punto.
        for names in number_hits.values():
            if len(names) <= 1:
                continue
            base = assigned[names[0]]
            count = len(names)
            radius = min(12.0, 3.2 / math.sin(math.pi / count))
            m_lon = 1.0 / (111139.0 * math.cos(math.radians(base["lat"])))
            for index, name in enumerate(names):
                angle = 2 * math.pi * index / count
                assigned[name] = {
                    "lon": base["lon"] + radius * math.cos(angle) * m_lon,
                    "lat": base["lat"] + radius * math.sin(angle) * m_lat,
                }

        placed_rows = []
        for name, portal_rows in groups.items():
            anchor = assigned.get(name)
            if anchor is None and centroid:
                anchor = {"lon": centroid[0], "lat": centroid[1]}
            if anchor is None:
                continue
            ordered = sorted(portal_rows, key=lambda row: (row["letra"], row["planta"] is None, row["planta"] or 0, row["id"]))
            slots = []
            index_of = {}
            for row in ordered:
                key = row["letra"]
                if key not in index_of:
                    index_of[key] = len(slots)
                    slots.append(key)
            count = len(slots)
            spacing = 0 if count <= 1 else min(2.8, 10.0 / (count - 1))
            origin = -((count - 1) * spacing) / 2.0
            m_lon = 1.0 / (111139.0 * math.cos(math.radians(anchor["lat"])))
            dup = Counter()
            for row in ordered:
                floor_key = (row["letra"], row["planta"])
                dup[floor_key] += 1
                east = origin + index_of[row["letra"]] * spacing
                north = (dup[floor_key] - 1) * 2.0
                placed_rows.append((row, anchor["lon"] + east * m_lon, anchor["lat"] + north * m_lat))

        if not placed_rows:
            sin_parcela += len(group)
            continue

        vias = Counter(row["via"] for row in group if row["via"])
        direccion = " · ".join(via for via, _count in vias.most_common(3)) or "Sin dirección"
        lon = sum(item[1] for item in placed_rows) / len(placed_rows)
        lat = sum(item[2] for item in placed_rows) / len(placed_rows)
        sample = placed_rows[0][0]
        edificios.append({
            "rc": rc,
            "lon": round(lon, 7),
            "lat": round(lat, 7),
            "direccion": direccion,
            "viviendas": len(group),
            "residentes": sum(row["hab"] for row in group),
            "tipo": "unifamiliar" if unica else "plurifamiliar",
            "planta": planta_txt(sample["planta"], True) if unica else "",
            "letra": sample["letra"] if unica else "",
            "ref": sample["ref"] if unica else "",
        })
        for row, lon_p, lat_p in placed_rows:
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(lon_p, 7), round(lat_p, 7), round(z_for(row["planta"]), 2)],
                },
                "properties": {
                    "id": row["id"],
                    "rc": rc,
                    "ref": row["ref"],
                    "direccion": row["via"] or direccion,
                    "planta": planta_txt(row["planta"], unica),
                    "letra": row["letra"],
                    "residentes": row["hab"],
                    "tipo": "unifamiliar" if unica else "plurifamiliar",
                    "incidencia": row.get("incidencia") or "",
                },
            })

    with (DATA / "viviendas.geojson").open("w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": features}, handle, ensure_ascii=False, separators=(",", ":"))
    with (DATA / "edificios.json").open("w", encoding="utf-8") as handle:
        json.dump(edificios, handle, ensure_ascii=False, separators=(",", ":"))

    lons = [item["lon"] for item in edificios]
    lats = [item["lat"] for item in edificios]
    center = [round(sum(lons) / len(lons), 6), round(sum(lats) / len(lats), 6)] if edificios else [-3.53, 40.35]
    meta = {
        "viviendas": len(features),
        "edificios": len(edificios),
        "sin_coordenada": sin_parcela,
        "sin_portal": sin_portal,
        "center": center,
    }
    with (DATA / "meta.json").open("w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
