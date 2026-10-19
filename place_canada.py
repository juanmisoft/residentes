# -*- coding: utf-8 -*-
"""Posiciona viviendas Cañada del padrón con centroides de NUEVAS_PARCELAS_CAÑADA.

Lee /tmp/canada_features.json (o data/canada_features.json), actualiza
padron_refcat.csv (excluded_canada → ok_canada_parcela) y data/manual_xy.json.
"""

from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
PADRON = DATA / "padron_refcat.csv"
MANUAL_XY = DATA / "manual_xy.json"
FEATURES_CANDIDATES = [
    DATA / "canada_features.json",
    Path("/tmp/canada_features.json"),
]
XY_OUT = DATA / "canada_parcel_xy.json"
INCIDENCIA = "Posición aproximada por parcela Cañada (sin ref. catastral)."


def is_rivas(attrs: dict) -> bool:
    mun = (attrs.get("MUNICIPIO") or "").upper()
    inc = (attrs.get("INCIDENCIA_PARCELA") or "").upper()
    return "RIVAS" in mun or "RIVAS" in inc


def nums_from(attrs: dict) -> set[str]:
    out: set[str] = set()
    for field in ("NUM_PARCE_OFICIAL", "PARCELA", "N_POLICIA_OFICIAL"):
        v = str(attrs.get(field) or "").strip().upper()
        if not v or v in {"0", "NONE", "NULL"}:
            continue
        for m in re.finditer(r"\d+", v):
            out.add(str(int(m.group())))
    return out


def centroid(geom: dict) -> tuple[float, float] | None:
    rings = geom.get("rings")
    if not rings:
        return None
    ring = max(rings, key=len)
    if len(ring) < 3:
        return None
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def mean_xy(pts: list[tuple[float, float]]) -> tuple[float, float]:
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def via_num(via: str) -> str | None:
    m = re.search(r"(\d+)\s*$", (via or "").strip())
    return str(int(m.group(1))) if m else None


def address_variants(via: str) -> list[str]:
    via = (via or "").strip()
    if not via:
        return []
    num = via_num(via)
    variants = [via]
    if num:
        # "CALLE … 100" ↔ "CALLE …, 0100" / ", 100"
        base = re.sub(r"\s+\d+\s*$", "", via).rstrip(" ,")
        variants.extend(
            [
                f"{base} {num}",
                f"{base}, {num}",
                f"{base}, {num.zfill(4)}",
            ]
        )
    # dedupe preserving order
    seen = set()
    out = []
    for v in variants:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def load_features() -> list[dict]:
    for path in FEATURES_CANDIDATES:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            feats = data if isinstance(data, list) else data.get("features") or []
            print(f"Parcelas desde {path} ({len(feats)})", flush=True)
            if path != FEATURES_CANDIDATES[0]:
                # cache local copy for rebuilds without /tmp
                FEATURES_CANDIDATES[0].write_text(
                    json.dumps(feats, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8",
                )
                print(f"  copiado a {FEATURES_CANDIDATES[0]}", flush=True)
            return feats
    raise SystemExit("No encuentro canada_features.json (data/ o /tmp/)")


def build_num_xy(feats: list[dict]) -> dict[str, tuple[float, float]]:
    by_num: dict[str, list[tuple[float, float]]] = defaultdict(list)
    used = 0
    for f in feats:
        attrs = f.get("attributes") or {}
        if not is_rivas(attrs):
            continue
        if str(attrs.get("ELIMINADO") or "").upper() == "SI":
            continue
        xy = centroid(f.get("geometry") or {})
        if not xy:
            continue
        used += 1
        for n in nums_from(attrs):
            by_num[n].append(xy)
    out = {n: mean_xy(pts) for n, pts in by_num.items()}
    print(f"Parcelas Rivas usadas: {used}  números: {len(out)}", flush=True)
    return out


def main():
    feats = load_features()
    num_xy = build_num_xy(feats)
    XY_OUT.write_text(
        json.dumps({n: [round(xy[0], 7), round(xy[1], 7)] for n, xy in sorted(num_xy.items(), key=lambda x: int(x[0]) if x[0].isdigit() else x[0])},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    rows = []
    with PADRON.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        fieldnames = reader.fieldnames
        for r in reader:
            rows.append(r)

    matched = 0
    unmatched_nums: set[str] = set()
    hab_m = hab_u = 0
    manual = {}
    if MANUAL_XY.exists():
        manual = json.loads(MANUAL_XY.read_text(encoding="utf-8"))

    for r in rows:
        if (r.get("match") or "").strip() != "excluded_canada":
            continue
        via = (r.get("VIA_NUMERO") or r.get("DireccionOriginal") or "").strip()
        num = via_num(via)
        try:
            hab = int((r.get("HABITANTES") or "0").strip() or 0)
        except ValueError:
            hab = 0
        if not num or num not in num_xy:
            if num:
                unmatched_nums.add(num)
            hab_u += hab
            continue
        lon, lat = num_xy[num]
        r["match"] = "ok_canada_parcela"
        matched += 1
        hab_m += hab
        for key in address_variants(via):
            manual[key] = [round(lon, 7), round(lat, 7)]
        # también DireccionOriginal si difiere
        dorig = (r.get("DireccionOriginal") or "").strip()
        if dorig and dorig != via:
            for key in address_variants(dorig):
                manual[key] = [round(lon, 7), round(lat, 7)]

    with PADRON.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writeheader()
        writer.writerows(rows)

    MANUAL_XY.write_text(json.dumps(manual, ensure_ascii=False, indent=2), encoding="utf-8")

    still = sum(1 for r in rows if (r.get("match") or "").strip() == "excluded_canada")
    print(
        f"OK matched={matched} hab={hab_m}  "
        f"quedan_excluded={still} hab_sin={hab_u}  "
        f"nums_sin={sorted(unmatched_nums, key=lambda x: int(x) if x.isdigit() else 0)}",
        flush=True,
    )
    print(f"manual_xy keys={len(manual)}  incidencia tip: {INCIDENCIA}", flush=True)


if __name__ == "__main__":
    main()
