# -*- coding: utf-8 -*-
"""Genera data/chat_stats.json (solo agregados, sin PII) para el chatbot de prueba.

Uso:
  python build_chat_stats.py
"""

from __future__ import annotations

import json
import re
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = DATA / "chat_stats.json"
BARRIOS_URL = (
    "https://sit.rivasciudad.es/server/rest/services/"
    "BARRIOS_POR_N_VIV_2020/FeatureServer/0/query"
    "?where=1%3D1&outFields=NOMBRE&returnGeometry=true&outSR=4326&f=geojson"
)
UA = {"User-Agent": "ResidentesChatStats/1.0"}

# Umbral para excluir residencias/colectivos en rankings de "casa unifamiliar"
COLECTIVO_MIN = 20


def point_in_ring(x: float, y: float, ring: list) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-30) + xi):
            inside = not inside
        j = i
    return inside


def point_in_poly(x: float, y: float, geom: dict) -> bool:
    t = geom.get("type")
    if t == "Polygon":
        rings = geom["coordinates"]
        if not point_in_ring(x, y, rings[0]):
            return False
        for hole in rings[1:]:
            if point_in_ring(x, y, hole):
                return False
        return True
    if t == "MultiPolygon":
        return any(
            point_in_poly(x, y, {"type": "Polygon", "coordinates": poly})
            for poly in geom["coordinates"]
        )
    return True


def load_geoms(path_or_fc) -> list:
    if isinstance(path_or_fc, Path):
        data = json.loads(path_or_fc.read_text(encoding="utf-8"))
    else:
        data = path_or_fc
    if data.get("type") == "FeatureCollection":
        return [f["geometry"] for f in data["features"]]
    if data.get("type") == "Feature":
        return [data["geometry"]]
    return [data]


def via_from_dir(direccion: str) -> str:
    d = (direccion or "").strip()
    d = re.sub(r"\s+\d+[A-Za-z]?(?:\s*[-/]\s*\d+[A-Za-z]?)?$", "", d)
    return re.sub(r"\s+", " ", d).strip() or "(sin vía)"


def is_espana(nac: str) -> bool:
    n = (nac or "").strip().lower().replace("ñ", "n")
    return n in {"espana", "españa", ""} or n.startswith("espan")


def main() -> None:
    viviendas = json.loads((DATA / "viviendas.geojson").read_text(encoding="utf-8"))
    personas = json.loads((DATA / "personas.json").read_text(encoding="utf-8"))
    limite_geoms = load_geoms(DATA / "limite.json")

    print("Descargando barrios…", flush=True)
    req = urllib.request.Request(BARRIOS_URL, headers=UA)
    with urllib.request.urlopen(req, timeout=90) as resp:
        barrios_fc = json.loads(resp.read().decode("utf-8"))
    (DATA / "barrios_chat.geojson").write_text(
        json.dumps(barrios_fc, ensure_ascii=False), encoding="utf-8"
    )

    feats = []
    for f in viviendas.get("features") or []:
        coords = (f.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        if not any(point_in_poly(lon, lat, g) for g in limite_geoms):
            continue
        props = f.get("properties") or {}
        feats.append({"lon": lon, "lat": lat, "props": props})

    barrio_polys = []
    for bf in barrios_fc.get("features") or []:
        nombre = (bf.get("properties") or {}).get("NOMBRE") or "Barrio"
        barrio_polys.append((nombre, bf["geometry"]))

    def barrio_of(lon: float, lat: float) -> str | None:
        for nombre, geom in barrio_polys:
            if point_in_poly(lon, lat, geom):
                return nombre
        return None

    # --- agregados ---
    barrio_edad_sum: dict[str, float] = defaultdict(float)
    barrio_edad_n: dict[str, int] = defaultdict(int)
    barrio_res: dict[str, int] = defaultdict(int)

    mujeres_20_30_via: Counter = Counter()
    nac_ext: Counter = Counter()
    extranjeros = 0
    total_personas = 0
    hombres = 0
    mujeres = 0
    edad_max = None
    longevos: list[dict] = []

    uni_ranking = []
    canada_viviendas = 0
    canada_residentes_campo = 0
    canada_personas = 0

    def is_canada(direccion: str, incidencia: str) -> bool:
        blob = f"{direccion or ''} {incidencia or ''}".upper().replace("Ñ", "N")
        return "CANADA REAL" in blob or "CANADA GALIANA" in blob

    for item in feats:
        props = item["props"]
        vid = str(props.get("vid") or props.get("id") or "")
        via = via_from_dir(props.get("direccion") or "")
        tipo = props.get("tipo") or ""
        incidencia = (props.get("incidencia") or "").strip()
        residentes = int(props.get("residentes") or 0)
        bname = barrio_of(item["lon"], item["lat"])
        en_canada = is_canada(props.get("direccion") or "", incidencia)
        if en_canada:
            canada_viviendas += 1
            canada_residentes_campo += residentes

        if tipo == "unifamiliar" and not incidencia and residentes < COLECTIVO_MIN:
            uni_ranking.append(
                {
                    "direccion": props.get("direccion") or "",
                    "residentes": residentes,
                    "vid": props.get("vid") or props.get("id"),
                }
            )

        for pers in personas.get(vid, []) or []:
            total_personas += 1
            if en_canada:
                canada_personas += 1
            sexo = (pers.get("sexo") or "").upper()
            if sexo == "H":
                hombres += 1
            elif sexo == "M":
                mujeres += 1
            edad = pers.get("edad")
            try:
                edad_i = int(edad) if edad is not None else None
            except (TypeError, ValueError):
                edad_i = None
            if bname and edad_i is not None:
                barrio_edad_sum[bname] += edad_i
                barrio_edad_n[bname] += 1
                barrio_res[bname] += 1
            if edad_i is not None:
                if edad_max is None or edad_i > edad_max:
                    edad_max = edad_i
                    longevos = []
                if edad_i == edad_max:
                    longevos.append(
                        {
                            "sexo": "mujer" if sexo == "M" else ("hombre" if sexo == "H" else None),
                            "barrio": bname,
                            "via": via,
                        }
                    )
            if sexo == "M" and edad_i is not None and 20 <= edad_i <= 30:
                mujeres_20_30_via[via] += 1
            nac = (pers.get("nacionalidad") or "").strip()
            if nac and not is_espana(nac):
                extranjeros += 1
                nac_ext[nac] += 1

    barrios = []
    for nombre in sorted(set(barrio_edad_n) | {n for n, _ in barrio_polys}):
        n = barrio_edad_n.get(nombre, 0)
        media = round(barrio_edad_sum[nombre] / n, 1) if n else None
        barrios.append(
            {
                "nombre": nombre,
                "residentes": barrio_res.get(nombre, 0),
                "edad_media": media,
            }
        )
    barrios_con_edad = [b for b in barrios if b["edad_media"] is not None]
    mas_joven = min(barrios_con_edad, key=lambda b: b["edad_media"]) if barrios_con_edad else None
    mas_viejo = max(barrios_con_edad, key=lambda b: b["edad_media"]) if barrios_con_edad else None

    uni_ranking.sort(key=lambda r: (-r["residentes"], r["direccion"]))
    top_uni = uni_ranking[:5]
    top_calles_m2030 = [
        {"via": via, "mujeres_20_30": n} for via, n in mujeres_20_30_via.most_common(10)
    ]
    top_nacionalidades = [
        {"nacionalidad": nac, "residentes": n} for nac, n in nac_ext.most_common(15)
    ]

    longevo_payload = None
    if edad_max is not None and longevos:
        sexos = Counter(x["sexo"] for x in longevos if x.get("sexo"))
        barrios_lon = Counter(x["barrio"] for x in longevos if x.get("barrio"))
        vias_lon = Counter(x["via"] for x in longevos if x.get("via"))
        longevo_payload = {
            "edad": edad_max,
            "personas": len(longevos),
            "sexo_predominante": sexos.most_common(1)[0][0] if sexos else None,
            "barrio": barrios_lon.most_common(1)[0][0] if barrios_lon else None,
            "via": vias_lon.most_common(1)[0][0] if vias_lon else None,
        }

    payload = {
        "version": 1,
        "ambito": "Dentro del límite municipal de Rivas-Vaciamadrid",
        "viviendas": len(feats),
        "residentes": total_personas,
        "hombres": hombres,
        "mujeres": mujeres,
        "extranjeros": extranjeros,
        "pct_extranjeros": round(100.0 * extranjeros / total_personas, 1) if total_personas else 0,
        "nacionalidades_distintas": len(nac_ext),
        "barrios": barrios,
        "barrio_mas_joven": mas_joven,
        "barrio_mas_envejecido": mas_viejo,
        "residente_mas_longevo": longevo_payload,
        "top_calles_mujeres_20_30": top_calles_m2030,
        "unifamiliar_mas_residentes": top_uni[0] if top_uni else None,
        "top_unifamiliares": top_uni,
        "top_nacionalidades": top_nacionalidades,
        "canada_real": {
            "viviendas": canada_viviendas,
            "residentes": canada_personas or canada_residentes_campo,
            "criterio": "Dirección o incidencia con «Cañada Real» / «Cañada Galiana».",
        },
        "notas": {
            "unifamiliar": (
                f"Se excluyen incidencias y viviendas con {COLECTIVO_MIN}+ residentes "
                "(posible residencia/colectivo)."
            ),
            "calles": "Agrupación por nombre de vía (sin número de portal).",
            "longevo": "Solo edad y ubicación agregada; sin nombres ni documentos.",
        },
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Escrito {OUT}")
    print(
        f"  residentes={total_personas} extranjeros={extranjeros} "
        f"canada={canada_personas or canada_residentes_campo} viv={canada_viviendas} "
        f"joven={mas_joven} viejo={mas_viejo} longevo={longevo_payload}"
    )
    if top_uni:
        print(f"  uni max: {top_uni[0]}")


if __name__ == "__main__":
    main()
