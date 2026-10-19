# -*- coding: utf-8 -*-
"""Consultas sobre las mismas viviendas que pinta el visor."""
import json
import os
import re
import unicodedata
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
GEOJSON = os.path.join(ROOT, "data", "viviendas.geojson")

_data = None
_PORTAL = re.compile(r"^(.*\D)\s+(\d+)\s*([A-Za-z])?$")


def plain(text):
    text = unicodedata.normalize("NFD", str(text or "").lower())
    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn")


def _portal(direccion):
    text = (direccion or "").strip()
    match = _PORTAL.match(text)
    if not match:
        return text, None, ""
    return match.group(1).strip(), int(match.group(2)), (match.group(3) or "").upper()


def _floor_key(planta):
    text = plain(planta)
    if "baja" in text or text in ("bj", "0", "pb"):
        return (0, text)
    if "sotano" in text or text.startswith("s"):
        return (-1, text)
    match = re.search(r"-?\d+", text)
    if match:
        return (int(match.group()), text)
    return (50, text)


def load():
    global _data
    if _data is not None:
        return _data
    with open(GEOJSON, encoding="utf-8") as handle:
        features = json.load(handle)["features"]
    by_rc = defaultdict(list)
    for feature in features:
        props = feature.get("properties") or {}
        by_rc[(props.get("rc") or "").strip()].append(feature)

    viviendas = []
    edificios = []
    for rc, group in by_rc.items():
        by_addr = defaultdict(list)
        for feature in group:
            addr = ((feature.get("properties") or {}).get("direccion") or "").strip()
            by_addr[addr].append(feature)
        houses = []
        apts = []
        for rows in by_addr.values():
            if len(rows) == 1:
                houses.append(rows[0])
            else:
                apts.extend(rows)
        for feature in houses:
            props = feature["properties"]
            lon, lat = feature["geometry"]["coordinates"][:2]
            calle, numero, sufijo = _portal(props.get("direccion") or "")
            row = {
                "rc": rc,
                "direccion": props.get("direccion") or "",
                "calle": calle,
                "numero": numero,
                "sufijo": sufijo,
                "planta": props.get("planta") or "",
                "letra": props.get("letra") or "",
                "residentes": int(props.get("residentes") or 0),
                "lon": lon,
                "lat": lat,
                "tipo": "unifamiliar",
            }
            viviendas.append(row)
            edificios.append({
                "rc": rc,
                "tipo": "unifamiliar",
                "direccion": row["direccion"],
                "calle": calle,
                "numero": numero,
                "lon": lon,
                "lat": lat,
                "viviendas": 1,
                "residentes": row["residentes"],
                "unidades": [row],
            })
        if apts:
            lon = 0
            lat = 0
            residentes = 0
            dirs = []
            units = []
            for feature in apts:
                coords = feature["geometry"]["coordinates"]
                lon += coords[0]
                lat += coords[1]
                props = feature["properties"]
                residentes += int(props.get("residentes") or 0)
                direccion = props.get("direccion") or ""
                if direccion not in dirs:
                    dirs.append(direccion)
                calle, numero, sufijo = _portal(direccion)
                unit = {
                    "rc": rc,
                    "direccion": direccion,
                    "calle": calle,
                    "numero": numero,
                    "sufijo": sufijo,
                    "planta": props.get("planta") or "",
                    "letra": props.get("letra") or "",
                    "residentes": int(props.get("residentes") or 0),
                    "lon": coords[0],
                    "lat": coords[1],
                    "tipo": "plurifamiliar",
                }
                units.append(unit)
                viviendas.append(unit)
            first = units[0]
            edificios.append({
                "rc": rc,
                "tipo": "plurifamiliar",
                "direccion": " · ".join(dirs[:3]),
                "calle": first["calle"],
                "numero": first["numero"],
                "lon": lon / len(apts),
                "lat": lat / len(apts),
                "viviendas": len(apts),
                "residentes": residentes,
                "unidades": units,
            })
    _data = {"viviendas": viviendas, "edificios": edificios}
    return _data


def _public(building):
    return {
        "rc": building["rc"],
        "tipo": building["tipo"],
        "direccion": building["direccion"],
        "lon": building["lon"],
        "lat": building["lat"],
        "viviendas": building["viviendas"],
        "residentes": building["residentes"],
    }


def _tipo(value):
    text = plain(value)
    if "pluri" in text or "bloque" in text:
        return "plurifamiliar"
    if "uni" in text or "casa" in text:
        return "unifamiliar"
    return ""


def _matches_street(building, calle):
    needle = plain(calle).strip()
    if not needle:
        return True
    haystack = plain(building.get("direccion") or "")
    return needle in haystack


def _filter_buildings(calle="", tipo="", numero=None):
    want = _tipo(tipo)
    rows = []
    for building in load()["edificios"]:
        if want and building["tipo"] != want:
            continue
        if calle and not _matches_street(building, calle):
            continue
        if numero is not None:
            numbers = {unit.get("numero") for unit in building["unidades"]}
            if int(numero) not in numbers:
                continue
        rows.append(building)
    return rows


def _as_int(value):
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def resumen(arguments):
    arguments = arguments or {}
    numero = _as_int(arguments.get("numero"))
    rows = _filter_buildings(arguments.get("calle") or "", arguments.get("tipo") or "", numero)
    viviendas = sum(int(row["viviendas"] or 0) for row in rows)
    residentes = sum(int(row["residentes"] or 0) for row in rows)
    unifamiliares = sum(row["viviendas"] for row in rows if row["tipo"] == "unifamiliar")
    plurifamiliares = sum(row["viviendas"] for row in rows if row["tipo"] == "plurifamiliar")
    media = (residentes / viviendas) if viviendas else 0
    return {
        "edificios": len(rows),
        "viviendas": viviendas,
        "residentes": residentes,
        "viviendas_unifamiliares": unifamiliares,
        "viviendas_plurifamiliares": plurifamiliares,
        "media_residentes_por_vivienda": round(media, 2),
        "filtro": {
            "calle": arguments.get("calle") or "",
            "tipo": _tipo(arguments.get("tipo")) or "todos",
            "numero": numero,
        },
    }


def ranking(arguments):
    arguments = arguments or {}
    campo = "viviendas" if plain(arguments.get("campo")) == "viviendas" else "residentes"
    menor = plain(arguments.get("orden")) in ("menor", "menos", "minimo", "minima", "asc")
    limite = _as_int(arguments.get("limite")) or 5
    limite = max(1, min(limite, 8))
    rows = _filter_buildings(arguments.get("calle") or "", arguments.get("tipo") or "")
    rows.sort(key=lambda row: (int(row[campo] or 0), plain(row["direccion"])), reverse=not menor)
    if menor:
        rows.sort(key=lambda row: (int(row[campo] or 0), plain(row["direccion"])))
    out = []
    for row in rows[:limite]:
        item = _public(row)
        item["campo"] = campo
        item["valor"] = int(row[campo] or 0)
        out.append(item)
    return {"campo": campo, "orden": "menor" if menor else "mayor", "resultados": out}


def buscar(arguments):
    arguments = arguments or {}
    texto = plain(arguments.get("texto") or arguments.get("calle") or "").strip()
    numero = _as_int(arguments.get("numero"))
    limite = max(1, min(_as_int(arguments.get("limite")) or 12, 20))
    if not texto and numero is None:
        return {"error": "Indica un texto de calle o dirección."}
    rows = _filter_buildings(texto, arguments.get("tipo") or "", numero)
    rows.sort(key=lambda row: (plain(row["direccion"]), row["numero"] or 0))
    return {
        "coincidencias": len(rows),
        "resultados": [_public(row) for row in rows[:limite]],
        "omitidos": max(0, len(rows) - limite),
    }


def detalle(arguments):
    arguments = arguments or {}
    texto = (arguments.get("direccion") or arguments.get("texto") or "").strip()
    rc = (arguments.get("rc") or "").strip()
    rows = []
    for building in load()["edificios"]:
        if rc and building["rc"] != rc:
            continue
        if texto and plain(texto) not in plain(building["direccion"]):
            continue
        rows.append(building)
    if not rows:
        return {"error": "No hay un edificio con esa dirección o referencia."}
    rows.sort(key=lambda row: (-len(row["unidades"]), plain(row["direccion"])))
    building = rows[0]
    units = sorted(building["unidades"], key=lambda unit: (_floor_key(unit["planta"]), unit["letra"], unit["direccion"]))
    listed = []
    for unit in units[:30]:
        listed.append({
            "direccion": unit["direccion"],
            "planta": unit["planta"],
            "letra": unit["letra"],
            "residentes": unit["residentes"],
        })
    return {
        "edificio": _public(building),
        "viviendas": listed,
        "omitidas": max(0, len(units) - len(listed)),
    }


def mostrar_en_mapa(arguments):
    found = detalle(arguments)
    if found.get("error"):
        return found
    return {"edificio": found["edificio"], "texto": "El visor puede abrir " + found["edificio"]["direccion"] + "."}


SPECS = [
    {
        "name": "resumen",
        "description": "Totales del padrón que pinta el visor: viviendas, residentes, unifamiliares y plurifamiliares. Filtra por calle, número o tipo si hace falta. Sin filtro devuelve todo el término.",
        "properties": {
            "calle": "Nombre de calle o fragmento, sin número. Ejemplo: Beguinas.",
            "numero": "Número de portal, si la pregunta lo cita.",
            "tipo": "unifamiliar, plurifamiliar o vacío para ambos.",
        },
    },
    {
        "name": "ranking",
        "description": "Ordena edificios del visor por residentes o por número de viviendas. Unifamiliar es una vivienda suelta. Plurifamiliar es un bloque con varias viviendas en la misma parcela.",
        "properties": {
            "tipo": "unifamiliar o plurifamiliar.",
            "campo": "residentes o viviendas.",
            "orden": "mayor o menor.",
            "calle": "Opcional. Limita el ranking a una calle.",
            "limite": "Cuántos devolver, de 1 a 8.",
        },
    },
    {
        "name": "buscar",
        "description": "Busca direcciones del padrón por texto y, si viene, por número de portal.",
        "properties": {
            "texto": "Calle o dirección.",
            "numero": "Número de portal opcional.",
            "tipo": "unifamiliar, plurifamiliar o vacío.",
            "limite": "Máximo de resultados, hasta 20.",
        },
    },
    {
        "name": "detalle",
        "description": "Desglose de una dirección o referencia catastral: plantas, letras y residentes de cada vivienda.",
        "properties": {
            "direccion": "Dirección o fragmento, por ejemplo Beatriz Galindo 12.",
            "rc": "Referencia catastral de 14 caracteres, si se conoce.",
        },
    },
    {
        "name": "mostrar_en_mapa",
        "description": "Abre en el visor el edificio del que habla la respuesta. Úsala cuando la respuesta señale una dirección concreta.",
        "properties": {
            "direccion": "Dirección del edificio a mostrar.",
            "rc": "Referencia catastral, si se conoce.",
            "tipo": "unifamiliar o plurifamiliar.",
        },
    },
]

_DISPATCH = {
    "resumen": resumen,
    "ranking": ranking,
    "buscar": buscar,
    "detalle": detalle,
    "mostrar_en_mapa": mostrar_en_mapa,
}


def dispatch(name, arguments):
    fn = _DISPATCH.get(name)
    if fn is None:
        return {"error": "Herramienta desconocida: " + str(name)}
    try:
        return fn(arguments or {})
    except Exception as exc:
        return {"error": str(exc)}
