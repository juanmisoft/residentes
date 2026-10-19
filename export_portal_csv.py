# -*- coding: utf-8 -*-
"""Exporta viviendas_portal.csv y personas_portal.csv desde data/."""

from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = ROOT / "export_portal"

VIV_FIELDS = [
    "vid",
    "id",
    "direccion",
    "tipo",
    "planta",
    "piso",
    "portal",
    "letra",
    "ref",
    "rc",
    "residentes",
    "hombres",
    "mujeres",
    "edad_media",
    "incidencia",
    "lon",
    "lat",
    "b0",
    "b1",
    "b2",
    "b3",
    "b4",
]
PER_FIELDS = ["vid", "nombre", "dni", "tipo_doc", "sexo", "edad", "anio", "nacionalidad"]


def main():
    geo = json.loads((DATA / "viviendas.geojson").read_text(encoding="utf-8"))
    personas = json.loads((DATA / "personas.json").read_text(encoding="utf-8"))
    OUT.mkdir(exist_ok=True)

    viv_path = OUT / "viviendas_portal.csv"
    with viv_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=VIV_FIELDS, delimiter=";")
        w.writeheader()
        for feat in geo.get("features") or []:
            props = feat.get("properties") or {}
            coords = (feat.get("geometry") or {}).get("coordinates") or [None, None]
            row = {k: props.get(k, "") for k in VIV_FIELDS}
            row["vid"] = props.get("vid") or props.get("id")
            row["id"] = props.get("id") or props.get("vid")
            row["lon"] = coords[0]
            row["lat"] = coords[1]
            for k in ("edad_media", "incidencia", "piso", "portal", "letra", "ref", "rc", "planta"):
                if row[k] is None:
                    row[k] = ""
            w.writerow(row)

    per_path = OUT / "personas_portal.csv"
    with per_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=PER_FIELDS, delimiter=";")
        w.writeheader()
        for vid, people in personas.items():
            for p in people:
                w.writerow(
                    {
                        "vid": vid,
                        "nombre": p.get("nombre") or "",
                        "dni": p.get("dni") or "",
                        "tipo_doc": p.get("tipo_doc") or "",
                        "sexo": p.get("sexo") or "",
                        "edad": p.get("edad") if p.get("edad") is not None else "",
                        "anio": p.get("anio") if p.get("anio") is not None else "",
                        "nacionalidad": p.get("nacionalidad") or "",
                    }
                )

    print(f"OK {viv_path.name} viviendas={len(geo.get('features') or [])}", flush=True)
    print(f"OK {per_path.name} personas={sum(len(v) for v in personas.values())}", flush=True)


if __name__ == "__main__":
    main()
