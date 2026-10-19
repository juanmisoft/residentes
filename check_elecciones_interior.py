# -*- coding: utf-8 -*-
"""Compara capas *_DATOSINTERIOR del SIT con ficheros MESA de Infoelectoral (MIR).

Fuente oficial de mesas:
  https://infoelectoral.interior.gob.es/estaticos/docxl/apliextr/{tipo}{YYYYMM}_MESA.zip

Tipos MIR: 02=Congreso, 04=Municipales, 07=Europeas.
Las autonómicas (Asamblea) NO están en Interior.

Uso:
  python check_elecciones_interior.py
"""

from __future__ import annotations

import io
import json
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "data" / "infoelectoral_tmp"
CACHE.mkdir(parents=True, exist_ok=True)

SIT = "https://sit.rivasciudad.es/server/rest/services"
MIR = "https://infoelectoral.interior.gob.es/estaticos/docxl/apliextr"
UA = {"User-Agent": "Mozilla/5.0 ResidentesCheck/1.0"}

# Rivas-Vaciamadrid
CCAA, PROV, MUN = "12", "28", "123"

# (label, sit_service, sit_layer_id, mir_tipo, yyyymm)
# mir_tipo: 02 congreso, 04 municipales, 07 europeas
CHECKS = [
    ("Europeas 2024", "Europeas_DATOSINTERIOR", 0, "07", "202406"),
    ("Europeas 2019", "Europeas_DATOSINTERIOR", 3, "07", "201905"),
    ("Europeas 2014", "Europeas_DATOSINTERIOR", 5, "07", "201405"),
    ("Generales 2023", "Generales_DATOSINTERIOR", 0, "02", "202307"),
    ("Generales 2019 Nov", "Generales_DATOSINTERIOR", 3, "02", "201911"),
    ("Generales 2019 Abr", "Generales_DATOSINTERIOR", 5, "02", "201904"),
    ("Generales 2016", "Generales_DATOSINTERIOR", 7, "02", "201606"),
    ("Generales 2015", "Generales_DATOSINTERIOR", 9, "02", "201512"),
    ("Municipales 2023", "Municipales_DATOSINTERIOR", 0, "04", "202305"),
    ("Municipales 2019", "Municipales_DATOSINTERIOR", 1, "04", "201905"),
    ("Municipales 2015", "Municipales_DATOSINTERIOR", 2, "04", "201505"),
    ("Municipales 2011", "Municipales_DATOSINTERIOR", 3, "04", "201105"),
    ("Municipales 2007", "Municipales_DATOSINTERIOR", 4, "04", "200705"),
]


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def http_json(url: str, params=None) -> dict:
    params = dict(params or {})
    params["f"] = "json"
    full = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    return json.loads(http_get(full).decode("utf-8"))


def ensure_mesa_zip(tipo: str, yyyymm: str) -> Path:
    name = f"{tipo}{yyyymm}_MESA.zip"
    dest = CACHE / name.replace(".zip", "")
    marker = dest / "_ok"
    if marker.exists():
        return dest
    url = f"{MIR}/{name}"
    print(f"  Descargando {name}…", flush=True)
    raw = http_get(url)
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        zf.extractall(dest)
    marker.write_text("ok", encoding="utf-8")
    return dest


def find_dat(folder: Path, prefix: str) -> Path:
    cands = list(folder.glob(f"{prefix}*.DAT")) + list(folder.glob(f"{prefix}*.dat"))
    if not cands:
        raise FileNotFoundError(f"No hay {prefix}*.DAT en {folder}")
    return cands[0]


def parse_mesa09(folder: Path) -> dict[str, dict]:
    """Agrega por sección censal los totales del fichero 09 (mesas)."""
    path = find_dat(folder, "09")
    by_sec: dict[str, dict] = defaultdict(
        lambda: {
            "CENSO": 0,
            "BLANCO": 0,
            "NULO": 0,
            "VOTOS_CAND": 0,
            "MESAS": 0,
        }
    )
    for ln in path.read_text(encoding="latin1").splitlines():
        if len(ln) < 86:
            continue
        if ln[9:11] != CCAA or ln[11:13] != PROV or ln[13:16] != MUN:
            continue
        sec = ln[18:21]
        by_sec[sec]["CENSO"] += int(ln[23:30])
        by_sec[sec]["BLANCO"] += int(ln[65:72])
        by_sec[sec]["NULO"] += int(ln[72:79])
        by_sec[sec]["VOTOS_CAND"] += int(ln[79:86])
        by_sec[sec]["MESAS"] += 1
    for sec, row in by_sec.items():
        row["VOTOS_TOTALES"] = row["BLANCO"] + row["NULO"] + row["VOTOS_CAND"]
        row["SECCION"] = sec
    return dict(by_sec)


def load_sit_layer(service: str, lid: int) -> dict[str, dict]:
    url = f"{SIT}/{service}/FeatureServer/{lid}/query"
    data = http_json(
        url,
        {
            "where": "1=1",
            "outFields": "SECCION,CENSO,BLANCO,NULO,VOTOS_CAND,VOTOS_TOTALES,MESAS",
            "returnGeometry": "false",
            "resultRecordCount": 2000,
        },
    )
    out = {}
    for feat in data.get("features") or []:
        a = feat.get("attributes") or {}
        sec = str(a.get("SECCION") or "").strip().zfill(3)
        out[sec] = {
            "CENSO": int(float(a.get("CENSO") or 0)),
            "BLANCO": int(float(a.get("BLANCO") or 0)),
            "NULO": int(float(a.get("NULO") or 0)),
            "VOTOS_CAND": int(float(a.get("VOTOS_CAND") or 0)),
            "VOTOS_TOTALES": int(float(a.get("VOTOS_TOTALES") or 0)),
            "MESAS": int(float(a.get("MESAS") or 0)),
        }
    return out


def compare(label: str, mir: dict[str, dict], sit: dict[str, dict]) -> dict:
    keys = ("CENSO", "BLANCO", "NULO", "VOTOS_CAND", "VOTOS_TOTALES", "MESAS")
    mir_tot = {k: sum(r[k] for r in mir.values()) for k in keys}
    sit_tot = {k: sum(r[k] for r in sit.values()) for k in keys}

    secs_mir = set(mir)
    secs_sit = set(sit)
    common = secs_mir & secs_sit
    only_mir = sorted(secs_mir - secs_sit)
    only_sit = sorted(secs_sit - secs_mir)

    sec_diffs = []
    for sec in sorted(common):
        diffs = {}
        for k in keys:
            if mir[sec][k] != sit[sec][k]:
                diffs[k] = (sit[sec][k], mir[sec][k], sit[sec][k] - mir[sec][k])
        if diffs:
            sec_diffs.append((sec, diffs))

    tot_ok = all(mir_tot[k] == sit_tot[k] for k in keys)
    return {
        "label": label,
        "mir_secciones": len(mir),
        "sit_secciones": len(sit),
        "common": len(common),
        "only_mir": only_mir,
        "only_sit": only_sit,
        "mir_tot": mir_tot,
        "sit_tot": sit_tot,
        "tot_ok": tot_ok,
        "sec_diffs": sec_diffs,
        "n_sec_diff": len(sec_diffs),
    }


def main():
    print("Comparación SIT *_DATOSINTERIOR  vs  Infoelectoral MESA (MIR)")
    print("Municipio INE: CCAA 12 · Prov 28 · Mun 123 (Rivas-Vaciamadrid)\n")

    results = []
    for label, service, lid, tipo, yyyymm in CHECKS:
        print(f"=== {label} ===", flush=True)
        try:
            folder = ensure_mesa_zip(tipo, yyyymm)
            mir = parse_mesa09(folder)
            sit = load_sit_layer(service, lid)
            res = compare(label, mir, sit)
            results.append(res)
        except Exception as exc:  # noqa: BLE001
            print(f"  ERROR: {exc}", flush=True)
            results.append({"label": label, "error": str(exc)})
            continue

        mt, st = res["mir_tot"], res["sit_tot"]
        print(
            f"  MIR secciones={res['mir_secciones']} mesas={mt['MESAS']} "
            f"censo={mt['CENSO']} votos={mt['VOTOS_TOTALES']}"
        )
        print(
            f"  SIT secciones={res['sit_secciones']} mesas={st['MESAS']} "
            f"censo={st['CENSO']} votos={st['VOTOS_TOTALES']}"
        )
        if res["tot_ok"]:
            print("  TOTALES MUNICIPIO: OK (coinciden con fichero MESA)")
        else:
            print("  TOTALES MUNICIPIO: DIFF")
            for k in mt:
                if mt[k] != st[k]:
                    print(f"    {k}: SIT={st[k]} MIR={mt[k]} Δ={st[k]-mt[k]:+d}")
        if res["only_sit"]:
            print(f"  Secciones solo en SIT ({len(res['only_sit'])}): {res['only_sit'][:12]}…")
        if res["only_mir"]:
            print(f"  Secciones solo en MIR ({len(res['only_mir'])}): {res['only_mir'][:12]}…")
        print(
            f"  Secciones comunes con diferencias: {res['n_sec_diff']}/{res['common']}"
        )
        for sec, diffs in res["sec_diffs"][:5]:
            bits = ", ".join(f"{k}: SIT={a} MIR={b}" for k, (a, b, _) in diffs.items())
            print(f"    sec {sec}: {bits}")
        if res["n_sec_diff"] > 5:
            print(f"    … y {res['n_sec_diff']-5} más")

    print("\n===== RESUMEN =====")
    print(
        "Nota: Asamblea_* no se comprueba aquí (elecciones autonómicas; "
        "Interior no publica mesas autonómicas en Infoelectoral)."
    )
    for res in results:
        if res.get("error"):
            print(f"- {res['label']}: ERROR {res['error']}")
            continue
        status = "OK" if res["tot_ok"] and res["n_sec_diff"] == 0 else (
            "OK totales / DIFF secciones" if res["tot_ok"] else "DIFF totales"
        )
        print(
            f"- {res['label']}: {status} "
            f"(MIR sec={res['mir_secciones']}, SIT sec={res['sit_secciones']}, "
            f"sec_diff={res['n_sec_diff']})"
        )


if __name__ == "__main__":
    main()
