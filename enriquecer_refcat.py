# -*- coding: utf-8 -*-
"""Obtiene la ReferenciaCatastral a partir de la dirección del padrón.

Lee «Habitantes a fecha ….xlsx» (una fila por persona), agrupa por vivienda
y resuelve la referencia con:

1. Callejero de Catastro (Consulta_DNPLOC)
2. Portales municipales de Rivas + listado de unidades Catastro (Consulta_DNPRC)

Salida agregada por vivienda, sin DNI ni nombres:
  data/padron_refcat.csv

Uso:
  py enriquecer_refcat.py
  py enriquecer_refcat.py --limit 80
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

DEFAULT_XLSX = ROOT / "Habitantes a fecha 08_10_26.xlsx"
CACHE_PATH = DATA / "catastro_dir_cache.json"
PORTALES_CACHE = DATA / "portales_refcat_cache.json"
OUT_PATH = DATA / "padron_refcat.csv"

CATASTRO_LOC = (
  "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/"
  "COVCCallejero.svc/json/Consulta_DNPLOC"
)
CATASTRO_RC = (
  "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/"
  "COVCCallejero.svc/json/Consulta_DNPRC"
)
PORTALES = (
  "https://sit.rivasciudad.es/server/rest/services/"
  "ACCESOS_PORTALES/FeatureServer/0/query"
)
PROVINCIA = "MADRID"
MUNICIPIO = "RIVAS-VACIAMADRID"

TIPOS = {
  "CALLE": "CL",
  "CL": "CL",
  "AVDA": "AV",
  "AVENIDA": "AV",
  "AV": "AV",
  "PASEO": "PS",
  "PS": "PS",
  "PLAZA": "PZ",
  "PZ": "PZ",
  "CAMINO": "CM",
  "CM": "CM",
  "CARRETERA": "CR",
  "CTRA": "CR",
  "CR": "CR",
  "GLORIETA": "GL",
  "TRAVESIA": "TR",
  "TRVA": "TR",
  "RONDA": "RD",
  "PASAJE": "PJ",
  "CALLEJON": "CJ",
  "URBANIZACION": "UR",
  "URB": "UR",
  "FINCA": "CL",
}


def col_like(columns, *needles):
  for col in columns:
    text = str(col).lower()
    if all(needle.lower() in text for needle in needles):
      return col
  raise KeyError("No se encuentra columna con: " + ", ".join(needles))


def norm_space(text):
  return re.sub(r"\s+", " ", (text or "").strip())


def norm_street_key(text):
  text = norm_space(text).upper()
  text = re.sub(r"\s*\([^)]*\)", " ", text)
  text = re.sub(
    r"^(CALLE|CL|AVDA|AVENIDA|AV|PASEO|PS|PLAZA|PZ|CAMINO|CM|CTRA|CARRETERA|CR|RONDA|RD)\s+",
    "",
    text,
  )
  # Guiones → espacio: CASTILLA-LA MANCHA ≡ CASTILLA LA MANCHA
  text = text.replace("-", " ")
  text = re.sub(r"[^A-Z0-9Ñ ]", "", text)
  return norm_space(text)


def parse_direccion(raw):
  text = norm_space(str(raw or ""))
  empty = {
    "raw": text,
    "sigla": "",
    "calle": "",
    "calle_extra": "",
    "numero": "",
    "portal": "",
    "piso": "",
    "puerta": "",
    "via_numero": "",
    "ok": False,
  }
  if not text:
    return empty

  # Formato habitual: «CALLE X, 0012 P01 A»
  # Sin coma (fincas / ctras): «FINCA PIUL (EL) 2», «CTRA VALENCIA 0019»
  if "," in text:
    left, right = text.split(",", 1)
    left = norm_space(left).upper()
    right = norm_space(right).upper()
  else:
    no_comma = re.match(r"^(.+?)\s+(\d+[A-Z\-]*)$", text.upper())
    if not no_comma:
      return empty
    left = norm_space(no_comma.group(1))
    right = norm_space(no_comma.group(2))
  if not right:
    return empty

  paren = re.search(r"\(([^)]+)\)", left)
  calle_extra = norm_space(paren.group(1)) if paren else ""

  tokens = re.sub(r"\s*\([^)]*\)", " ", left).split()
  sigla = "CL"
  calle_tokens = tokens
  if tokens:
    first = tokens[0].rstrip(".")
    if first in TIPOS:
      sigla = TIPOS[first]
      calle_tokens = tokens[1:]
  calle = norm_space(" ".join(calle_tokens))

  # Número: 0012 | 0001-B | 0001A
  num_match = re.match(r"^(\d+)(?:\s*-\s*([A-Z0-9]+)|([A-Z]))?(?:\s+|$)(.*)$", right)
  if not num_match:
    return empty
  numero = str(int(num_match.group(1)))
  suffix = (num_match.group(2) or num_match.group(3) or "").strip()
  rest = norm_space(num_match.group(4)).split() if num_match.group(4) else []

  portal = suffix
  piso = ""
  puerta = ""
  piso_idx = next(
    (
      i
      for i, token in enumerate(rest)
      if re.fullmatch(r"P\d+", token)
      or re.fullmatch(r"A\d+", token)  # A01 = ático en padrón
      or token in {"PB", "PBJ", "BJ", "BAJO", "SS", "SOT", "AT", "ATICO"}
    ),
    None,
  )
  if piso_idx is not None:
    piso = rest[piso_idx]
    if re.fullmatch(r"A\d+", piso):
      piso = "AT"
    before = rest[:piso_idx]
    after = rest[piso_idx + 1 :]
    if before and not portal:
      portal = before[0]
    elif before and portal:
      # Ya había sufijo en el número; el token anterior suele ser portal/bloque
      portal = before[0]
    if after:
      puerta = after[0]
  elif rest:
    if not portal:
      portal = rest[0]
      after = rest[1:]
    else:
      after = rest
    # «1 A01 A» → portal 1, ático, puerta A
    if (
      len(after) >= 2
      and re.fullmatch(r"A\d+", after[0])
      and re.fullmatch(r"[A-Z]", after[1])
    ):
      piso = "AT"
      puerta = after[1]
    elif after:
      puerta = after[0]

  return {
    "raw": text,
    "sigla": sigla,
    "calle": calle,
    "calle_extra": calle_extra,
    "numero": numero,
    "portal": portal,
    "piso": piso,
    "puerta": puerta,
    "via_numero": norm_space(f"{re.sub(r'\s*\([^)]*\)', '', left)} {numero}"),
    "ok": bool(calle and numero),
  }


_ARTICULOS = {"DE", "DEL", "LA", "LAS", "EL", "LOS", "Y"}


def calle_variants(parsed):
  """Variantes de nombre de vía para Catastro.

  Prueba el nombre tal cual, con/sin artículos del paréntesis (DEL, DE LA…),
  palabras representativas (ARCO IRIS → ARCOIRIS) y orden invertido.
  """
  base = parsed["calle"]
  extra = parsed["calle_extra"]
  variants = [base]

  # 1 DE MAYO → 1º DE MAYO
  ordinal = re.sub(r"\b(\d+)\s+DE\s+MAYO\b", r"\1º DE MAYO", base)
  if ordinal != base:
    variants.append(ordinal)

  # (DEL) / (DE LOS) → ARCO IRIS DEL, DEL ARCO IRIS, etc.
  if extra:
    variants.append(norm_space(f"{base} {extra}"))
    variants.append(norm_space(f"{extra} {base}"))
    words = [word for word in re.split(r"\s+", extra) if word not in _ARTICULOS]
    if not words and extra in {"EL", "LA", "LOS", "LAS", "DEL"}:
      words = [extra]
    for word in words:
      variants.append(norm_space(f"{base} {word}"))
      variants.append(norm_space(f"{word} {base}"))

  # Palabra(s) representativa(s): quitar artículos del propio nombre
  tokens = [tok for tok in base.replace("-", " ").split() if tok not in _ARTICULOS]
  if tokens:
    core = norm_space(" ".join(tokens))
    variants.append(core)
    # ARCO IRIS → ARCOIRIS (Catastro a veces compacta)
    if len(tokens) >= 2:
      variants.append("".join(tokens))
    for tok in tokens:
      if len(tok) >= 4:
        variants.append(tok)

  # Variantes ortográficas frecuentes padrón ↔ callejero municipal
  spelling = {
    "EUCALIPTOS": "EUCALIPTUS",
    "EUCALIPTUS": "EUCALIPTOS",
  }
  for src_name, dst_name in spelling.items():
    more = []
    for item in variants:
      if src_name in item:
        more.append(item.replace(src_name, dst_name))
    variants.extend(more)

  cleaned = []
  for item in variants:
    text = norm_space(item.replace("-", " "))
    if text and text not in cleaned:
      cleaned.append(text)
  return cleaned


def planta_catastro(piso):
  value = (piso or "").strip().upper()
  if not value:
    return ""
  if value in {"PB", "PBJ", "BJ", "BAJO", "P00", "00"}:
    return "00"
  if value in {"AT", "ATIC", "ATICO", "ATT"}:
    return "AT"
  if value in {"SS", "SOT", "SOTANO"}:
    return "SS"
  match = re.fullmatch(r"P(\d+)", value)
  if match:
    return match.group(1).zfill(2)
  if value.isdigit():
    return value.zfill(2)
  return value


def puerta_catastro(puerta):
  value = (puerta or "").strip().upper()
  if not value:
    return ""
  # «A01 A» residual: nos quedamos con la letra final si viene rara
  if re.fullmatch(r"A\d+", value):
    return ""
  if value.isdigit():
    return value.zfill(2) if len(value) <= 2 else value
  return value


def is_garage_unit(unit):
  """Garajes/trasteros: no emparejar con viviendas del padrón."""
  es = (unit.get("es") or "").strip().upper()
  pt = (unit.get("pt") or "").strip().upper()
  return pt in {"-1", "-2"} or es.startswith("G")


def rc_from_parts(rc):
  if not rc:
    return ""
  return "".join(
    [
      rc.get("pc1") or "",
      rc.get("pc2") or "",
      rc.get("car") or "",
      rc.get("cc1") or "",
      rc.get("cc2") or "",
    ]
  )


NETWORK_ERRORS = (
  urllib.error.URLError,
  TimeoutError,
  ConnectionResetError,
  ConnectionAbortedError,
  ConnectionError,
  OSError,
)


def http_json(url, params, retries=1):
  query = {key: value for key, value in params.items() if value not in (None, "")}
  full = url + "?" + urllib.parse.urlencode(query)
  # El host municipal usa certificado propio.
  context = None
  if "rivasciudad.es" in url:
    import ssl

    context = ssl._create_unverified_context()

  last_err = None
  for attempt in range(retries):
    req = urllib.request.Request(full, headers={"User-Agent": "Mozilla/5.0"})
    try:
      with urllib.request.urlopen(req, timeout=20, context=context) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))
    except NETWORK_ERRORS as err:
      last_err = err
      if attempt + 1 < retries:
        time.sleep(2.0)
  raise last_err


def load_json(path, default):
  if not path.exists():
    return default
  try:
    return json.loads(path.read_text(encoding="utf-8"))
  except Exception:
    return default


def save_json(path, payload):
  path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def _unit_from_item(item):
  """Extrae ref + localización interior + nº de policía (pnp) de un inmueble Catastro."""
  rc = ((item.get("idbi") or {}).get("rc")) or (item.get("rc") or {})
  lourb = (
    ((((item.get("dt") or {}).get("locs") or {}).get("lous") or {}).get("lourb") or {})
  )
  loint = lourb.get("loint") or {}
  dire = lourb.get("dir") or {}
  return {
    "ref": rc_from_parts(rc),
    "bq": (loint.get("bq") or "").strip().upper(),
    "es": (loint.get("es") or "").strip().upper(),
    "pt": (loint.get("pt") or "").strip().upper(),
    "pu": (loint.get("pu") or "").strip().upper(),
    "pnp": str(dire.get("pnp") or "").strip(),
    "nv": (dire.get("nv") or "").strip().upper(),
  }


def units_from_dnploc(result):
  units = []
  bico = result.get("bico")
  if bico and (bico.get("bi") or {}).get("idbi"):
    units.append(_unit_from_item(bico["bi"]))

  rcdnp = ((result.get("lrcdnp") or {}).get("rcdnp")) or []
  if isinstance(rcdnp, dict):
    rcdnp = [rcdnp]
  for item in rcdnp:
    units.append(_unit_from_item(item))
  return dedupe_units(units)


def units_from_dnprc(result):
  units = []
  # Un único inmueble
  bico = result.get("bico")
  if bico and (bico.get("bi") or {}).get("idbi"):
    units.append(_unit_from_item(bico["bi"]))
  # Lista de inmuebles de la parcela
  rcdnp = ((result.get("lrcdnp") or {}).get("rcdnp")) or []
  if isinstance(rcdnp, dict):
    rcdnp = [rcdnp]
  for item in rcdnp:
    units.append(_unit_from_item(item))
  return dedupe_units(units)


def dedupe_units(units):
  seen = set()
  unique = []
  for unit in units:
    ref = unit.get("ref") or ""
    if len(ref) < 14 or ref in seen:
      continue
    seen.add(ref)
    unique.append(unit)
  return unique


def _pu_equal(unit_pu, want):
  left = (unit_pu or "").strip().upper()
  right = (want or "").strip().upper()
  if not right:
    return False
  if left == right:
    return True
  if left.isdigit() and right.isdigit():
    return str(int(left)) == str(int(right))
  if len(right) <= 2:
    return left.zfill(2) == right.zfill(2)
  return False


def _match_townhouse(units, portal):
  """Adosado/unifamiliar: padrón «… 0002 93» ↔ Catastro Bq:C93 / Pu:93."""
  if not portal or not portal.isdigit():
    return []
  code = f"C{int(portal)}"
  by_bq = [unit for unit in units if (unit.get("bq") or "").upper() == code]
  if by_bq:
    return by_bq
  return [
    unit
    for unit in units
    if _pu_equal(unit.get("pu"), portal) and not (unit.get("es") or "").strip()
  ]


def pick_unit(units, parsed):
  if not units:
    return None, "not_found"
  if len(units) == 1:
    return units[0], "ok_unico"

  pt = planta_catastro(parsed["piso"])
  pu = puerta_catastro(parsed["puerta"])
  portal = (parsed["portal"] or "").strip().upper()
  portal_num = portal.zfill(2) if portal.isdigit() else portal
  numero = str(parsed.get("numero") or "").strip()

  # Padrón = viviendas: aparcar garajes/trasteros (Pl:-1/-2, Es:G*).
  dwellings = [unit for unit in units if not is_garage_unit(unit)]
  pool = dwellings if dwellings else units

  # Nº de policía Catastro (pnp): parcela grande con varios portales (p.ej. Marguerite).
  if numero and any(unit.get("pnp") for unit in pool):
    by_pnp = [
      unit
      for unit in pool
      if (unit.get("pnp") or "").lstrip("0") == numero.lstrip("0")
      or (unit.get("pnp") or "") == numero
    ]
    if by_pnp:
      pool = by_pnp

  def _try_townhouse(code):
    town = _match_townhouse(pool, code)
    if len(town) == 1:
      return town[0], "ok_match"
    if len(town) > 1:
      parcels = {unit["ref"][:14] for unit in town if len(unit["ref"]) >= 14}
      if len(parcels) == 1:
        return town[0], "ok_parcela"
      # Varias parcelas del mismo portal municipal con el mismo C{n}/puerta.
      return town[0], "ok_parcela_ambigua"
    return None, None

  # Unifamiliares gemelos: portal municipal con 2 parcelas y padrón «130» / «130-B».
  # Catastro a menudo no discrimina (Es:T Pl:OD Pt:OS); el orden del portal = A / B.
  if not pt and not pu and len(pool) == 2:
    twins = sorted(pool, key=lambda unit: unit.get("ref") or "")
    useless = all(
      (unit.get("es") or "") in {"", "T"}
      and (unit.get("pt") or "") in {"", "OD", "00"}
      and (unit.get("pu") or "") in {"", "OS"}
      for unit in twins
    )
    if useless:
      if portal in {"B", "2"}:
        return twins[1], "ok_match"
      if not portal or portal in {"A", "1"}:
        return twins[0], "ok_match"

  # Solo número de portal (sin piso/letra) → adosado C{n} antes que escalera.
  if portal and not pt and not pu:
    unit, status = _try_townhouse(portal)
    if status:
      return unit, status
    stair = [unit for unit in pool if (unit.get("es") or "").upper() == portal]
    if len(stair) == 1:
      return stair[0], "ok_match"
    if stair:
      return None, "ambiguous"

  # «… 0011 PBJ 80» → la puerta numérica es el adosado C80 (solo bajo / sin piso alto).
  if pu and pu.isdigit() and not portal and (not pt or pt in {"00", "BJ"}):
    unit, status = _try_townhouse(pu)
    if status:
      return unit, status

  candidates = pool
  if pt:
    filtered = [
      unit
      for unit in candidates
      if (unit["pt"] or "").zfill(2) == pt.zfill(2) or unit["pt"] == pt
    ]
    if filtered:
      candidates = filtered
    else:
      # BeCasa / hotel: padrón P07 701 → Catastro Pl:AT Pt:01 (ático).
      floor_pts = {(unit.get("pt") or "").upper() for unit in pool}
      raw_pu = (parsed.get("puerta") or "").strip()
      floor_num = str(int(pt)) if pt.isdigit() else ""
      if (
        "AT" in floor_pts
        and floor_num
        and raw_pu.isdigit()
        and raw_pu.startswith(floor_num)
        and len(raw_pu) > len(floor_num)
      ):
        pt = "AT"
        pu = raw_pu[len(floor_num) :].zfill(2)
        candidates = [unit for unit in pool if (unit.get("pt") or "").upper() == "AT"]
  if pu:
    filtered = [unit for unit in candidates if _pu_equal(unit.get("pu"), pu)]
    if filtered:
      candidates = filtered
  if portal:
    filtered = [
      unit
      for unit in candidates
      if (unit.get("es") or "").upper() == portal
      or (unit.get("bq") or "").upper() == portal
      or (unit.get("bq") or "").upper() == f"C{portal}"
      or (portal.isdigit() and (unit.get("bq") or "").upper() == f"C{int(portal)}")
      or portal_num in {(unit.get("bq") or ""), (unit.get("es") or "")}
    ]
    if filtered:
      candidates = filtered

  if len(candidates) == 1:
    return candidates[0], "ok_match"

  parcels = {unit["ref"][:14] for unit in candidates if len(unit["ref"]) >= 14}
  if len(parcels) == 1:
    # Unifamiliar / parcela única: si no hay piso, vale la unidad o la parcela.
    if not parsed["piso"] and not parsed["puerta"]:
      return candidates[0], "ok_parcela"
    return candidates[0], "ok_parcela_ambigua"

  # Mismo piso/puerta en 2+ parcelas del portal municipal (bloques gemelos).
  if pt and pu:
    same = {
      ((unit.get("pt") or ""), (unit.get("pu") or "").lstrip("0") or (unit.get("pu") or ""))
      for unit in candidates
    }
    if len(same) == 1:
      return candidates[0], "ok_parcela_ambigua"

  return None, "ambiguous"


def cache_key(sigla, calle, numero):
  return f"{sigla}|{calle}|{numero}"


# Si Catastro corta la conexión, se evita durante un rato y se usa el portal.
_catastro_cooldown_until = 0.0
CATASTRO_COOLDOWN_S = 120.0


def fetch_units_catastro(parsed, cache, sleep_s):
  global _catastro_cooldown_until
  key = cache_key(parsed["sigla"], parsed["calle"], parsed["numero"])
  if key in cache:
    return cache[key]

  if time.time() < _catastro_cooldown_until:
    return {"ok": False, "error": "network:cooldown", "units": [], "fuente": "dnploc"}

  # Siglas alternativas: AVDA↔AV, CL↔CALLE…
  siglas = [parsed["sigla"]]
  for alt in ("AV", "CL", "PS", "PZ"):
    if alt not in siglas:
      siglas.append(alt)

  last_error = ""
  for variant in calle_variants(parsed):
    for sigla in siglas:
      try:
        data = http_json(
          CATASTRO_LOC,
          {
            "Provincia": PROVINCIA,
            "Municipio": MUNICIPIO,
            "Sigla": sigla,
            "Calle": variant,
            "Numero": parsed["numero"],
          },
        )
      except (*NETWORK_ERRORS, json.JSONDecodeError) as exc:
        last_error = f"network:{exc}"
        print(f"    red/catastro: {exc}", flush=True)
        _catastro_cooldown_until = time.time() + CATASTRO_COOLDOWN_S
        payload = {"ok": False, "error": last_error, "units": [], "fuente": "dnploc"}
        return payload

      result = data.get("consulta_dnplocResult") or {}
      units = units_from_dnploc(result)
      if units:
        payload = {
          "ok": True,
          "error": "",
          "units": units,
          "fuente": "dnploc",
          "calle": variant,
          "sigla": sigla,
        }
        cache[key] = payload
        if sleep_s:
          time.sleep(sleep_s)
        return payload

      control = result.get("control") or {}
      if control.get("cuerr"):
        last_error = "; ".join(
          item.get("des") or "" for item in (result.get("lerr") or [])
        )
      if sleep_s:
        time.sleep(sleep_s)

  payload = {"ok": False, "error": last_error or "sin resultado", "units": [], "fuente": "dnploc"}
  # No cachear cortes de red: se reintentarán en una pasada posterior.
  if not str(last_error).startswith("network:"):
    cache[key] = payload
  return payload


def load_portales():
  cached = load_json(PORTALES_CACHE, None)
  if cached:
    return cached

  print("Descargando portales municipales…", flush=True)
  by_key = defaultdict(list)
  offset = 0
  page = 2000
  while True:
    data = http_json(
      PORTALES,
      {
        "where": "REFCATASTRAL IS NOT NULL AND REFCATASTRAL <> 'SIN UBICACION PRECISA'",
        "outFields": "REFCATASTRAL,ACCESO,CALLE,ACRDESACC",
        "returnGeometry": "false",
        "resultOffset": offset,
        "resultRecordCount": page,
        "f": "json",
      },
    )
    if data.get("error"):
      raise RuntimeError(data["error"])
    batch = data.get("features") or []
    for feature in batch:
      attrs = feature.get("attributes") or {}
      rc = (attrs.get("REFCATASTRAL") or "").strip()[:14]
      calle = norm_street_key(attrs.get("CALLE") or "")
      acceso = re.sub(r"\D", "", str(attrs.get("ACCESO") or ""))
      if len(rc) < 14 or not calle or not acceso:
        continue
      by_key[f"{calle}|{int(acceso)}"].append(rc)
    print(f"  {offset + len(batch)}", flush=True)
    if not data.get("exceededTransferLimit") or not batch:
      break
    offset += len(batch)

  payload = {key: sorted(set(values)) for key, values in by_key.items()}
  save_json(PORTALES_CACHE, payload)
  print(f"  portales indexados: {len(payload)}", flush=True)
  return payload


def fetch_units_portal(parsed, portales, cache, sleep_s):
  street = norm_street_key(parsed["calle"])
  key = f"portal|{street}|{parsed['numero']}"
  if key in cache:
    return cache[key]

  refs = portales.get(f"{street}|{int(parsed['numero'])}", [])
  if not refs:
    # Prueba variantes con artículo
    for variant in calle_variants(parsed):
      refs = portales.get(f"{norm_street_key(variant)}|{int(parsed['numero'])}", [])
      if refs:
        break
  if not refs:
    payload = {"ok": False, "error": "sin portal municipal", "units": [], "fuente": "portal"}
    cache[key] = payload
    return payload

  units = []
  network_fail = False
  for rc14 in refs:
    try:
      data = http_json(CATASTRO_RC, {"RefCat": rc14})
    except (*NETWORK_ERRORS, json.JSONDecodeError) as exc:
      print(f"    red/dnprc: {exc}", flush=True)
      network_fail = True
      # Sin Catastro: basta la RC del portal municipal (parcela / unifamiliar).
      units.append({"ref": rc14, "bq": "", "es": "", "pt": "", "pu": ""})
      continue
    result = data.get("consulta_dnprcResult") or {}
    found = units_from_dnprc(result)
    if found:
      units.extend(found)
    else:
      units.append({"ref": rc14, "bq": "", "es": "", "pt": "", "pu": ""})
    if sleep_s:
      time.sleep(sleep_s)

  units = dedupe_units(units)
  payload = {
    "ok": bool(units),
    "error": "" if units else "portal sin unidades",
    "units": units,
    "fuente": "portal",
  }
  cache[key] = payload
  return payload


def resolve_from_portal_local(parsed, portales):
  """Resuelve con el índice municipal, sin red."""
  if not parsed.get("numero"):
    return None, "not_found"
  street = norm_street_key(parsed["calle"])
  refs = portales.get(f"{street}|{int(parsed['numero'])}", [])
  if not refs:
    for variant in calle_variants(parsed):
      refs = portales.get(f"{norm_street_key(variant)}|{int(parsed['numero'])}", [])
      if refs:
        break
  if not refs:
    return None, "not_found"
  unit, status = pick_unit(
    [{"ref": rc, "bq": "", "es": "", "pt": "", "pu": ""} for rc in refs],
    parsed,
  )
  return unit, status


def resolve_dwelling(parsed, portales, cache, sleep_s, portal_only=False):
  # Reutilizar resultado Catastro ya cacheado (también en modo portal-only).
  key = cache_key(parsed["sigla"], parsed["calle"], parsed["numero"])
  cached = cache.get(key)
  if cached and cached.get("ok"):
    unit, status = pick_unit(cached.get("units") or [], parsed)
    if unit:
      return unit, status, cached.get("fuente") or "dnploc"

  catastro_net = False
  if not portal_only:
    payload = fetch_units_catastro(parsed, cache, sleep_s)
    if payload.get("ok"):
      unit, status = pick_unit(payload.get("units") or [], parsed)
      if unit:
        return unit, status, payload.get("fuente") or "dnploc"
    catastro_net = str(payload.get("error") or "").startswith("network:")

  if portal_only:
    unit, status = resolve_from_portal_local(parsed, portales)
    if unit:
      return unit, status, "portal"
    return None, "not_found", "portal"

  payload = fetch_units_portal(parsed, portales, cache, sleep_s)
  if payload.get("ok"):
    unit, status = pick_unit(payload.get("units") or [], parsed)
    if unit:
      return unit, status, "portal"
    if status == "ambiguous":
      return None, "ambiguous", "portal"

  if catastro_net or payload.get("error") == "network":
    return None, "network_error", payload.get("fuente") or "dnploc"
  if payload.get("error"):
    return None, "not_found", "portal"
  return None, "not_found", "dnploc"


def is_padron_local(tipo):
  """Incluye viviendas y establecimientos colectivos (residencias, etc.)."""
  text = (tipo or "").strip().lower()
  if not text:
    return True
  if "vivienda" in text:
    return True
  if "colectivo" in text:
    return True
  return False


def load_padron(path):
  df = pd.read_excel(path, sheet_name=0)
  dir_col = col_like(df.columns, "direcc")
  tipo_cols = [col for col in df.columns if "tipo local" in str(col).lower()]
  tipo_col = tipo_cols[0] if tipo_cols else None

  rows = []
  for _, row in df.iterrows():
    tipo = ""
    if tipo_col is not None:
      tipo = str(row.get(tipo_col) or "")
      if not is_padron_local(tipo):
        continue
    direccion = row.get(dir_col)
    if pd.isna(direccion):
      continue
    rows.append(
      {
        "direccion": str(direccion).strip(),
        "tipo_local": tipo.strip(),
      }
    )
  return rows


def aggregate(addresses):
  counts = defaultdict(int)
  tipos = defaultdict(str)
  for item in addresses:
    if isinstance(item, dict):
      direccion = item["direccion"]
      tipo = item.get("tipo_local") or ""
    else:
      direccion = item
      tipo = ""
    counts[direccion] += 1
    if tipo and not tipos[direccion]:
      tipos[direccion] = tipo
  dwellings = []
  for direccion, habitantes in counts.items():
    dwellings.append(
      {
        "direccion": direccion,
        "parsed": parse_direccion(direccion),
        "habitantes": habitantes,
        "tipo_local": tipos.get(direccion) or "",
      }
    )
  return dwellings


def is_canada_real(text):
  """Cañada Real: asentamiento irregular; Catastro lo trata como rústico."""
  upper = (text or "").upper().replace("Ñ", "N")
  return "CANADA REAL" in upper


def is_excluded_dwelling(direccion, parsed=None):
  """Direcciones que no deben cruzarse con vivienda Catastro."""
  if is_canada_real(direccion) or is_canada_real((parsed or {}).get("via_numero") or ""):
    return "excluded_canada"
  parsed = parsed or parse_direccion(direccion)
  calle = norm_street_key(parsed.get("calle") or "")
  numero = str(parsed.get("numero") or "")
  # Av. José Hierro 29: parcela deportiva, sin viviendas.
  if calle == "JOSE HIERRO" and numero == "29":
    return "excluded_deportivo"
  return ""


def main():
  parser = argparse.ArgumentParser(description="Enriquece el padrón con ReferenciaCatastral")
  parser.add_argument("--xlsx", default=str(DEFAULT_XLSX), help="Excel de habitantes")
  parser.add_argument("--limit", type=int, default=0, help="Solo N viviendas (prueba)")
  parser.add_argument(
    "--max-new",
    type=int,
    default=0,
    help="Solo N consultas nuevas (no cacheadas). Ideal para lotes suaves.",
  )
  parser.add_argument("--sleep", type=float, default=0.35, help="Pausa entre consultas nuevas")
  parser.add_argument(
    "--stop-on-net",
    action="store_true",
    help="Parar el lote al primer error de red (recomendado en pruebas)",
  )
  parser.add_argument(
    "--portal-only",
    action="store_true",
    help="Solo portales municipales (no llama a Catastro). Útil si Catastro bloquea.",
  )
  parser.add_argument(
    "--retry-failed",
    action="store_true",
    help="Borra de la caché los fallos previos para reintentar con Catastro.",
  )
  args = parser.parse_args()

  xlsx = Path(args.xlsx)
  if not xlsx.exists():
    raise SystemExit(f"No está el Excel: {xlsx}")

  print(f"Leyendo {xlsx.name}…", flush=True)
  people = load_padron(xlsx)
  dwellings = aggregate(people)
  dwellings.sort(
    key=lambda item: (
      item["parsed"]["sigla"],
      item["parsed"]["calle"],
      item["parsed"]["numero"],
      item["direccion"],
    )
  )
  if args.limit:
    seen = set()
    sample = []
    for item in dwellings:
      key = cache_key(item["parsed"]["sigla"], item["parsed"]["calle"], item["parsed"]["numero"])
      if key in seen:
        continue
      seen.add(key)
      sample.append(item)
      if len(sample) >= args.limit:
        break
    dwellings = sample
  print(f"Viviendas a recorrer: {len(dwellings)}", flush=True)
  if args.max_new:
    print(f"Lote máximo de consultas nuevas: {args.max_new}", flush=True)

  portales = load_portales()
  cache = load_json(CACHE_PATH, {})
  if args.retry_failed:
    before = len(cache)
    cache = {key: value for key, value in cache.items() if value.get("ok")}
    print(f"Caché: eliminados {before - len(cache)} fallos para reintentar.", flush=True)
    save_json(CACHE_PATH, cache)
  out_rows = []
  stats = defaultdict(int)
  new_queries = 0
  stopped_early = False

  for index, dwelling in enumerate(dwellings, start=1):
    parsed = dwelling["parsed"]
    excluded = is_excluded_dwelling(dwelling["direccion"], parsed)
    if excluded:
      stats[excluded] += 1
      out_rows.append(
        {
          "REFCAT_14": "",
          "ReferenciaCatastral": "",
          "VIA_NUMERO": parsed["via_numero"] or dwelling["direccion"],
          "PORTAL": parsed["portal"],
          "PISO": parsed["piso"],
          "PUERTA": parsed["puerta"],
          "HABITANTES": dwelling["habitantes"],
          "DireccionOriginal": dwelling["direccion"],
          "TipoLocal": dwelling.get("tipo_local") or "",
          "match": excluded,
          "fuente": "excluded",
        }
      )
    elif not parsed["ok"]:
      stats["parse_error"] += 1
      out_rows.append(
        {
          "REFCAT_14": "",
          "ReferenciaCatastral": "",
          "VIA_NUMERO": parsed["via_numero"] or dwelling["direccion"],
          "PORTAL": parsed["portal"],
          "PISO": parsed["piso"],
          "PUERTA": parsed["puerta"],
          "HABITANTES": dwelling["habitantes"],
          "DireccionOriginal": dwelling["direccion"],
          "TipoLocal": dwelling.get("tipo_local") or "",
          "match": "parse_error",
          "fuente": "",
        }
      )
    else:
      key = cache_key(parsed["sigla"], parsed["calle"], parsed["numero"])
      portal_key = f"portal|{norm_street_key(parsed['calle'])}|{parsed['numero']}"
      was_cached = (key in cache) or (args.portal_only and portal_key in cache)
      try:
        unit, status, fuente = resolve_dwelling(
          parsed, portales, cache, args.sleep, portal_only=args.portal_only
        )
      except NETWORK_ERRORS as exc:
        print(f"    red (skip): {dwelling['direccion']} → {exc}", flush=True)
        unit, status, fuente = None, "network_error", ""
      if not was_cached:
        new_queries += 1
      if status == "network_error":
        time.sleep(5.0)
        if args.stop_on_net:
          stats[status] += 1
          ref = (unit or {}).get("ref") or ""
          out_rows.append(
            {
              "REFCAT_14": ref[:14],
              "ReferenciaCatastral": ref,
              "VIA_NUMERO": parsed["via_numero"],
              "PORTAL": parsed["portal"],
              "PISO": parsed["piso"],
              "PUERTA": parsed["puerta"],
              "HABITANTES": dwelling["habitantes"],
              "DireccionOriginal": dwelling["direccion"],
              "TipoLocal": dwelling.get("tipo_local") or "",
              "match": status,
              "fuente": fuente,
            }
          )
          print("  Corte de red: se detiene el lote para no martillar Catastro.", flush=True)
          stopped_early = True
          break
      stats[status] += 1
      ref = (unit or {}).get("ref") or ""
      out_rows.append(
        {
          "REFCAT_14": ref[:14],
          "ReferenciaCatastral": ref,
          "VIA_NUMERO": parsed["via_numero"],
          "PORTAL": parsed["portal"],
          "PISO": parsed["piso"],
          "PUERTA": parsed["puerta"],
          "HABITANTES": dwelling["habitantes"],
          "DireccionOriginal": dwelling["direccion"],
          "TipoLocal": dwelling.get("tipo_local") or "",
          "match": status,
          "fuente": fuente,
        }
      )

      if args.max_new and new_queries >= args.max_new:
        print(f"  Lote completado ({new_queries} consultas nuevas).", flush=True)
        stopped_early = True
        break

    if index % 25 == 0 or index == len(dwellings) or stopped_early:
      save_json(CACHE_PATH, cache)
      ok = stats["ok_unico"] + stats["ok_match"] + stats["ok_parcela"] + stats["ok_parcela_ambigua"]
      print(
        f"  {index}/{len(dwellings)}  ok={ok}  amb={stats['ambiguous']}  "
        f"nf={stats['not_found']}  net={stats['network_error']}  parse={stats['parse_error']}  "
        f"new={new_queries}",
        flush=True,
      )
    if stopped_early:
      break

  save_json(CACHE_PATH, cache)
  summary = {
    "viviendas_recorridas": len(out_rows),
    "consultas_nuevas": new_queries,
    "stopped_early": stopped_early,
    "cache": str(CACHE_PATH),
    **stats,
  }
  # En lotes parciales solo se actualiza la caché; el CSV completo al acabar todo.
  if stopped_early and args.max_new:
    summary["nota"] = "Lote parcial: caché actualizada, CSV no reescrito"
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return

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
  with OUT_PATH.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=fieldnames, delimiter=";")
    writer.writeheader()
    writer.writerows(out_rows)

  summary["salida"] = str(OUT_PATH)
  summary["viviendas"] = len(out_rows)
  print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
  main()
