# -*- coding: utf-8 -*-
"""Actualiza las capas de viviendas y personas en ArcGIS Enterprise.

Pide usuario y contraseña del Portal.

Modos:
  Completo (lento): vacía cada capa y vuelve a cargar todo.
  Parcial (rápido): solo borra/reinserta los vid o ref indicados.

Uso:
  python publish_portal.py
  python publish_portal.py --only viviendas
  python publish_portal.py --only personas
  python publish_portal.py --vids 15659,15660
  python publish_portal.py --ref 6144603VK5664S0003IQ,6144603VK5664S0004OW

Variables opcionales (si existen, no pide esa parte):
  PORTAL_URL, PORTAL_USER, PORTAL_PASSWORD
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CONFIG_JS = ROOT / "config.js"

DEFAULT_PORTAL = "https://sit.rivasciudad.es/portal"
BATCH = 400
UA = "ResidentesPortalPublisher/1.0"


def load_config():
  cfg = {
    "portalUrl": os.environ.get("PORTAL_URL") or DEFAULT_PORTAL,
    "viviendasItemId": "",
    "personasItemId": "",
  }
  if CONFIG_JS.exists():
    text = CONFIG_JS.read_text(encoding="utf-8")
    for key in ("portalUrl", "viviendasItemId", "personasItemId"):
      m = re.search(rf"{key}\s*:\s*[\"']([^\"']+)[\"']", text)
      if m:
        cfg[key] = m.group(1).strip()
  if os.environ.get("PORTAL_URL"):
    cfg["portalUrl"] = os.environ["PORTAL_URL"].rstrip("/")
  else:
    cfg["portalUrl"] = (cfg.get("portalUrl") or DEFAULT_PORTAL).rstrip("/")
  return cfg


def http_json(url, params=None, data=None, method=None):
  params = dict(params or {})
  if data is None:
    params.setdefault("f", "json")
    full = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": UA}, method=method or "GET")
  else:
    body = urllib.parse.urlencode({**params, **data, "f": "json"}).encode("utf-8")
    req = urllib.request.Request(
      url,
      data=body,
      headers={
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method=method or "POST",
    )
  try:
    with urllib.request.urlopen(req, timeout=180) as resp:
      return json.loads(resp.read().decode("utf-8"))
  except urllib.error.HTTPError as exc:
    detail = exc.read().decode("utf-8", errors="replace")[:500]
    raise RuntimeError(f"HTTP {exc.code} {url}: {detail}") from exc


def generate_token(portal_url, username, password):
  referer = portal_url.rstrip("/")
  # Enterprise suele aceptar sharing/rest/generateToken
  endpoints = [
    f"{portal_url}/sharing/rest/generateToken",
    f"{portal_url}/sharing/generateToken",
  ]
  last_err = None
  for endpoint in endpoints:
    try:
      payload = http_json(
        endpoint,
        data={
          "username": username,
          "password": password,
          "client": "referer",
          "referer": referer,
          "expiration": 120,
        },
      )
    except Exception as exc:  # noqa: BLE001
      last_err = exc
      continue
    if payload.get("token"):
      return payload["token"]
    last_err = RuntimeError(payload.get("error") or payload)
  raise RuntimeError(f"No se pudo obtener token: {last_err}")


def item_info(portal_url, item_id, token):
  data = http_json(
    f"{portal_url}/sharing/rest/content/items/{item_id}",
    params={"token": token},
  )
  if data.get("error"):
    raise RuntimeError(f"Item {item_id}: {data['error']}")
  return data


def layer_url_from_item(item):
  url = (item.get("url") or "").rstrip("/")
  if not url:
    raise RuntimeError(f"El item {item.get('id')} no tiene URL de servicio")
  # FeatureServer o FeatureServer/0
  if re.search(r"/FeatureServer/\d+$", url, re.I):
    return url
  if url.lower().endswith("/featureserver"):
    return url + "/0"
  return url


def layer_meta(layer_url, token):
  meta = http_json(layer_url, params={"token": token})
  if meta.get("error"):
    raise RuntimeError(meta["error"])
  return meta


def field_map(meta):
  """nombre_lower → nombre real en el servicio."""
  mapping = {}
  for field in meta.get("fields") or []:
    name = field.get("name") or ""
    if not name:
      continue
    mapping[name.lower()] = name
  return mapping


def remap_attrs(attrs, fmap, skip=None):
  skip = {s.lower() for s in (skip or [])}
  out = {}
  for key, value in attrs.items():
    lk = key.lower()
    if lk in skip:
      continue
    if lk not in fmap:
      continue
    if value is None:
      continue
    out[fmap[lk]] = value
  return out


def query_count(layer_url, token):
  data = http_json(
    layer_url.rstrip("/") + "/query",
    params={"where": "1=1", "returnCountOnly": "true", "token": token},
  )
  if data.get("error"):
    raise RuntimeError(data["error"])
  return int(data.get("count") or 0)


def delete_all(layer_url, token):
  print("  Vaciando capa…", flush=True)
  # Enterprise a veces limita el borrado por lote: repetir hasta 0.
  for attempt in range(1, 80):
    remaining = query_count(layer_url, token)
    if remaining == 0:
      print("  Capa vacía", flush=True)
      return
    print(f"  Borrando… quedan {remaining} (pasada {attempt})", flush=True)
    trunc = http_json(
      layer_url.rstrip("/") + "/deleteFeatures",
      data={"where": "1=1", "token": token},
    )
    if trunc.get("error"):
      raise RuntimeError(trunc["error"])
    time.sleep(0.3)
  left = query_count(layer_url, token)
  if left:
    raise RuntimeError(f"No se vació del todo: quedan {left} registros")


def add_features(layer_url, token, features, label):
  total = len(features)
  if not total:
    print(f"  {label}: 0 filas", flush=True)
    return
  print(f"  Subiendo {label}: {total}…", flush=True)
  for start in range(0, total, BATCH):
    chunk = features[start : start + BATCH]
    payload = http_json(
      layer_url.rstrip("/") + "/addFeatures",
      data={
        "features": json.dumps(chunk, ensure_ascii=False),
        "token": token,
      },
    )
    if payload.get("error"):
      raise RuntimeError(payload["error"])
    results = payload.get("addResults") or []
    failed = [r for r in results if not r.get("success")]
    if failed:
      sample = failed[0]
      raise RuntimeError(f"Fallo al insertar ({label}): {sample}")
    done = min(start + len(chunk), total)
    if done == total or done % (BATCH * 5) < BATCH:
      print(f"    {done}/{total}", flush=True)
    time.sleep(0.05)
  print(f"  {label}: listo", flush=True)


def delete_where(layer_url, token, where):
  print(f"  Borrando where: {where}", flush=True)
  payload = http_json(
    layer_url.rstrip("/") + "/deleteFeatures",
    data={"where": where, "token": token},
  )
  if payload.get("error"):
    raise RuntimeError(payload["error"])
  deleted = payload.get("deleteResults") or []
  ok = sum(1 for r in deleted if r.get("success"))
  print(f"  Borrados: {ok}", flush=True)


def vid_where(vids):
  """Cláusula SQL para vid numéricos o texto."""
  nums = []
  texts = []
  for vid in vids:
    s = str(vid).strip()
    if not s:
      continue
    if s.isdigit():
      nums.append(s)
    else:
      texts.append("'" + s.replace("'", "''") + "'")
  parts = []
  if nums:
    parts.append("vid IN (" + ",".join(nums) + ")")
  if texts:
    parts.append("vid IN (" + ",".join(texts) + ")")
  if not parts:
    raise ValueError("Lista de vids vacía")
  return " OR ".join(parts)


def vids_from_refs(refs):
  """Resuelve referencias catastrales → vid usando viviendas.geojson."""
  want = {str(r).strip().upper() for r in refs if str(r).strip()}
  geo = json.loads((DATA / "viviendas.geojson").read_text(encoding="utf-8"))
  found = []
  for feat in geo.get("features") or []:
    props = feat.get("properties") or {}
    ref = str(props.get("ref") or "").strip().upper()
    if ref not in want:
      continue
    vid = props.get("vid") or props.get("id")
    if vid is not None:
      found.append(str(vid))
  if not found:
    raise SystemExit("Ningún vid para las ref indicadas: " + ", ".join(sorted(want)))
  return found


def parse_csv_arg(value):
  if not value:
    return []
  return [part.strip() for part in str(value).split(",") if part.strip()]


def build_vivienda_features(fmap, has_geometry, vids=None):
  geo = json.loads((DATA / "viviendas.geojson").read_text(encoding="utf-8"))
  allow = {str(v) for v in vids} if vids else None
  features = []
  for feat in geo.get("features") or []:
    props = feat.get("properties") or {}
    vid = props.get("vid") or props.get("id")
    if allow is not None and str(vid) not in allow:
      continue
    coords = (feat.get("geometry") or {}).get("coordinates") or []
    attrs = {
      "vid": vid,
      "id": props.get("id") or props.get("vid"),
      "direccion": props.get("direccion") or "",
      "tipo": props.get("tipo") or "",
      "planta": props.get("planta") or "",
      "piso": props.get("piso") or "",
      "portal": props.get("portal") or "",
      "letra": props.get("letra") or "",
      "ref": props.get("ref") or "",
      "rc": props.get("rc") or "",
      "residentes": props.get("residentes"),
      "hombres": props.get("hombres"),
      "mujeres": props.get("mujeres"),
      "edad_media": props.get("edad_media"),
      "incidencia": props.get("incidencia") or "",
      "lon": coords[0] if len(coords) > 0 else None,
      "lat": coords[1] if len(coords) > 1 else None,
      "b0": props.get("b0"),
      "b1": props.get("b1"),
      "b2": props.get("b2"),
      "b3": props.get("b3"),
      "b4": props.get("b4"),
    }
    row = {"attributes": remap_attrs(attrs, fmap, skip={"objectid", "fid", "globalid"})}
    if has_geometry and len(coords) >= 2:
      row["geometry"] = {
        "x": float(coords[0]),
        "y": float(coords[1]),
        "spatialReference": {"wkid": 4326},
      }
    features.append(row)
  return features


def build_persona_features(fmap, vids=None):
  personas = json.loads((DATA / "personas.json").read_text(encoding="utf-8"))
  allow = {str(v) for v in vids} if vids else None
  features = []
  for vid, people in personas.items():
    if allow is not None and str(vid) not in allow:
      continue
    for person in people or []:
      attrs = {
        "vid": int(vid) if str(vid).isdigit() else vid,
        "nombre": person.get("nombre") or "",
        "dni": person.get("dni") or "",
        "tipo_doc": person.get("tipo_doc") or "",
        "sexo": person.get("sexo") or "",
        "edad": person.get("edad"),
        "anio": person.get("anio"),
        "nacionalidad": person.get("nacionalidad") or "",
      }
      features.append(
        {"attributes": remap_attrs(attrs, fmap, skip={"objectid", "fid", "globalid"})}
      )
  return features


def update_item(portal_url, token, item_id, kind, vids=None):
  mode = "parcial" if vids else "completo"
  print(f"\n=== {kind} ({item_id}) [{mode}] ===", flush=True)
  item = item_info(portal_url, item_id, token)
  title = item.get("title") or item_id
  print(f"  Item: {title}", flush=True)
  layer_url = layer_url_from_item(item)
  print(f"  Layer: {layer_url}", flush=True)
  meta = layer_meta(layer_url, token)
  fmap = field_map(meta)
  geom_type = (meta.get("geometryType") or "") or ""
  has_geometry = bool(geom_type)
  print(
    f"  Campos: {len(fmap)}  geometría: {geom_type or 'tabla'}",
    flush=True,
  )

  if kind == "viviendas":
    features = build_vivienda_features(fmap, has_geometry, vids=vids)
  else:
    features = build_persona_features(fmap, vids=vids)

  if vids:
    print(f"  Vids a parchear: {', '.join(str(v) for v in vids)}", flush=True)
    delete_where(layer_url, token, vid_where(vids))
  else:
    delete_all(layer_url, token)
  add_features(layer_url, token, features, kind)
  print(f"  Conteo en servicio: {query_count(layer_url, token)}", flush=True)


def prompt_auth(portal_url):
  print(f"Portal: {portal_url}", flush=True)
  user = os.environ.get("PORTAL_USER") or input("Usuario Portal: ").strip()
  password = os.environ.get("PORTAL_PASSWORD")
  if not password:
    password = getpass.getpass("Contraseña: ")
  if not user or not password:
    raise SystemExit("Usuario y contraseña son obligatorios.")
  return user, password


def main():
  parser = argparse.ArgumentParser(description="Actualiza viviendas/personas en Enterprise")
  parser.add_argument(
    "--only",
    choices=("viviendas", "personas", "both"),
    default="both",
    help="Qué capa actualizar",
  )
  parser.add_argument(
    "--vids",
    default="",
    help="Solo estos vid (coma-separados). Mucho más rápido que republicar todo.",
  )
  parser.add_argument(
    "--ref",
    default="",
    help="Solo estas ref. catastrales (coma-separadas); se resuelven a vid.",
  )
  parser.add_argument(
    "--yes",
    action="store_true",
    help="En modo completo, no pedir confirmación SI (sigue pidiendo login).",
  )
  args = parser.parse_args()

  if not (DATA / "viviendas.geojson").exists() or not (DATA / "personas.json").exists():
    raise SystemExit("Faltan data/viviendas.geojson o data/personas.json. Ejecuta build_padron_visor.py antes.")

  vids = parse_csv_arg(args.vids)
  refs = parse_csv_arg(args.ref)
  if refs:
    vids = list(dict.fromkeys(vids + vids_from_refs(refs)))
  vids = list(dict.fromkeys(vids)) or None

  cfg = load_config()
  portal = cfg["portalUrl"]
  viv_id = cfg["viviendasItemId"]
  per_id = cfg["personasItemId"]
  if not viv_id or not per_id:
    raise SystemExit("Faltan viviendasItemId / personasItemId en config.js")

  if vids:
    print(f"Modo parcial: {len(vids)} vivienda(s) → {', '.join(vids)}", flush=True)
  else:
    print("Modo completo: se vaciarán y recargarán las capas enteras.", flush=True)
    print(
      "AVISO: no interrumpas este proceso. Si se corta a mitad, la capa puede\n"
      "quedar vacía o incompleta y 'desaparecerán' viviendas en el mapa.",
      flush=True,
    )
    if not args.yes:
      confirm = input("Escribe SI para continuar con la carga completa: ").strip()
      if confirm.upper() not in {"SI", "SÍ", "YES", "Y"}:
        raise SystemExit("Cancelado.")

  user, password = prompt_auth(portal)
  print("Autenticando…", flush=True)
  token = generate_token(portal, user, password)
  print("Token OK", flush=True)

  try:
    if args.only in ("viviendas", "both"):
      update_item(portal, token, viv_id, "viviendas", vids=vids)
    if args.only in ("personas", "both"):
      update_item(portal, token, per_id, "personas", vids=vids)
  except Exception as exc:  # noqa: BLE001
    print(f"\nERROR: {exc}", file=sys.stderr, flush=True)
    raise SystemExit(1) from exc

  print("\nActualización terminada. Recarga el visor (dataSource: portal).", flush=True)


if __name__ == "__main__":
  main()
