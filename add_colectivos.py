# -*- coding: utf-8 -*-
"""Añade establecimientos colectivos al padrón enriquecido (residencias, etc.).

No reescribe todo el CSV: solo inserta las direcciones que faltan, resuelve
REFCAT vía caché de portales y guarda coordenadas (parcelas municipales / Catastro).
"""

from __future__ import annotations

import csv
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from enriquecer_refcat import (
  CACHE_PATH,
  DEFAULT_XLSX,
  OUT_PATH,
  PORTALES_CACHE,
  aggregate,
  load_json,
  load_padron,
  load_portales,
  norm_street_key,
  resolve_dwelling,
  save_json,
)

DATA = Path(__file__).resolve().parent / "data"
COORDS = DATA / "coords_cache.json"
PARCELAS = (
  "https://sit.rivasciudad.es/server/rest/services/"
  "PARCELAS_CATASTRALES_URBANA/FeatureServer/0/query"
)
PORTALES_XY = (
  "https://sit.rivasciudad.es/server/rest/services/"
  "ACCESOS_PORTALES/FeatureServer/0/query"
)


def http_json(url, params):
  qs = urllib.parse.urlencode({**params, "f": "json"})
  req = urllib.request.Request(f"{url}?{qs}", headers={"User-Agent": "Mozilla/5.0"})
  with urllib.request.urlopen(req, timeout=60) as resp:
    return json.loads(resp.read().decode("utf-8"))


def parcel_centroid(rc: str):
  try:
    data = http_json(
      PARCELAS,
      {
        "where": f"REFCAT='{rc}'",
        "outFields": "REFCAT",
        "returnGeometry": "false",
        "returnCentroid": "true",
        "outSR": "4326",
      },
    )
  except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
    print(f"  parcela {rc}: {exc}", flush=True)
    return None
  feats = data.get("features") or []
  if not feats:
    return None
  center = feats[0].get("centroid") or {}
  if "x" not in center or "y" not in center:
    return None
  return float(center["x"]), float(center["y"])


def portal_xy(rc: str):
  try:
    data = http_json(
      PORTALES_XY,
      {
        "where": f"REFCATASTRAL LIKE '{rc}%'",
        "outFields": "REFCATASTRAL",
        "returnGeometry": "true",
        "outSR": "4326",
        "resultRecordCount": 5,
      },
    )
  except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
    print(f"  portal-xy {rc}: {exc}", flush=True)
    return None
  feats = data.get("features") or []
  xs, ys = [], []
  for feat in feats:
    geom = feat.get("geometry") or {}
    if "x" in geom and "y" in geom:
      xs.append(float(geom["x"]))
      ys.append(float(geom["y"]))
  if not xs:
    return None
  return sum(xs) / len(xs), sum(ys) / len(ys)


def catastro_coord(rc: str):
  url = (
    "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/"
    "COVCCoordenadas.svc/json/Consulta_CPMRC"
  )
  try:
    data = http_json(url, {"RefCat": rc, "SRS": "EPSG:4326"})
  except Exception as exc:
    print(f"  catastro {rc}: {exc}", flush=True)
    return None
  coords = (
    ((data.get("Consulta_CPMRCResult") or {}).get("coordenadas") or {}).get("coord")
    or []
  )
  if not coords:
    return None
  geo = coords[0].get("geo") or {}
  try:
    return float(geo["xcen"]), float(geo["ycen"])
  except (KeyError, TypeError, ValueError):
    return None


def resolve_xy(rc14: str):
  if not rc14:
    return None
  return parcel_centroid(rc14) or portal_xy(rc14) or catastro_coord(rc14)


def portal_rc(parsed, portales_cache) -> str:
  street = norm_street_key(parsed.get("calle") or "")
  numero = parsed.get("numero") or ""
  if not street or not numero:
    return ""
  try:
    key = f"{street}|{int(numero)}"
  except ValueError:
    key = f"{street}|{numero}"
  refs = portales_cache.get(key) or []
  if isinstance(refs, list) and refs:
    return str(refs[0])[:14]
  return ""


def main():
  xlsx = DEFAULT_XLSX
  print(f"Leyendo colectivos de {xlsx.name}...", flush=True)
  people = load_padron(xlsx)
  dwellings = [
    d
    for d in aggregate(people)
    if "colectivo" in (d.get("tipo_local") or "").lower()
  ]
  print(f"Establecimientos colectivos: {len(dwellings)}", flush=True)

  existing = {}
  fieldnames = None
  if OUT_PATH.exists():
    with OUT_PATH.open(encoding="utf-8", newline="") as handle:
      reader = csv.DictReader(handle, delimiter=";")
      fieldnames = list(reader.fieldnames or [])
      for row in reader:
        key = (row.get("DireccionOriginal") or "").strip().upper()
        if key:
          existing[key] = row

  if not fieldnames:
    fieldnames = [
      "REFCAT_14",
      "ReferenciaCatastral",
      "VIA_NUMERO",
      "PORTAL",
      "PISO",
      "PUERTA",
      "HABITANTES",
      "DireccionOriginal",
      "TipoLocal",
      "match",
      "fuente",
    ]
  if "TipoLocal" not in fieldnames:
    fieldnames = fieldnames + ["TipoLocal"]

  portales = load_portales()
  cache = load_json(CACHE_PATH, {})
  portales_cache = load_json(PORTALES_CACHE, {})
  coords = load_json(COORDS, {})

  added = 0
  updated = 0
  for dwelling in dwellings:
    direccion = dwelling["direccion"]
    key = direccion.strip().upper()
    parsed = dwelling["parsed"]
    was_present = key in existing
    if not parsed.get("ok"):
      print(f"  parse fail: {direccion}", flush=True)
      continue

    unit, status, fuente = resolve_dwelling(
      parsed, portales, cache, sleep_s=0.0, portal_only=True
    )
    ref = (unit or {}).get("ref") or ""
    rc14 = (ref[:14] if ref else portal_rc(parsed, portales_cache))
    if not ref and rc14:
      ref = rc14 + "0001QS"
      status = "ok_parcela"
      fuente = "portal"

    row = {
      "REFCAT_14": rc14,
      "ReferenciaCatastral": ref,
      "VIA_NUMERO": parsed.get("via_numero") or direccion,
      "PORTAL": parsed.get("portal") or "",
      "PISO": parsed.get("piso") or "",
      "PUERTA": parsed.get("puerta") or "",
      "HABITANTES": str(dwelling["habitantes"]),
      "DireccionOriginal": direccion,
      "TipoLocal": dwelling.get("tipo_local") or "Establecimiento colectivo",
      "match": status,
      "fuente": fuente or "portal",
    }

    if was_present:
      existing[key] = {**existing[key], **row}
      updated += 1
      action = "upd"
    else:
      existing[key] = row
      added += 1
      action = "add"

    xy = None
    if rc14:
      if rc14 in coords and len(coords[rc14]) >= 2:
        xy = (float(coords[rc14][0]), float(coords[rc14][1]))
      else:
        xy = resolve_xy(rc14)
        if xy:
          coords[rc14] = [xy[0], xy[1]]

    xy_txt = f"{xy[0]:.6f},{xy[1]:.6f}" if xy else "sin-xy"
    print(
      f"  {action} {direccion} hab={dwelling['habitantes']} "
      f"rc={rc14 or '-'} {status} {xy_txt}",
      flush=True,
    )

  rows = list(existing.values())
  rows.sort(key=lambda r: (r.get("VIA_NUMERO") or "", r.get("DireccionOriginal") or ""))
  with OUT_PATH.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=fieldnames, delimiter=";", extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)

  save_json(CACHE_PATH, cache)
  save_json(COORDS, coords)
  print(
    json.dumps(
      {
        "csv": str(OUT_PATH),
        "total": len(rows),
        "colectivos": len(dwellings),
        "added": added,
        "updated": updated,
        "coords": len(coords),
      },
      ensure_ascii=False,
      indent=2,
    )
  )


if __name__ == "__main__":
  main()
