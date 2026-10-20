# -*- coding: utf-8 -*-
"""Actualiza el visor con un nuevo Excel de Habitantes (padrón).

Uso habitual:
  1. Copia el fichero a la carpeta del proyecto, p. ej.:
       Habitantes a fecha 15_11_26.xlsx
  2. Ejecuta:
       python actualizar_padron.py "Habitantes a fecha 15_11_26.xlsx" --publish
  3. Introduce usuario/contraseña del Portal cuando lo pida.
  4. Recarga el visor.

Pasos que hace por detrás:
  A) enriquecer_refcat.py  → data/padron_refcat.csv  (reusa caché Catastro)
  B) build_padron_visor.py → data/viviendas.geojson + data/personas.json
  C) build_chat_stats.py   → data/chat_stats.json
  D) Actualiza fechaPadron en config.js
  E) (opcional) publish_portal.py → capas Enterprise

Opciones:
  --skip-enriquecer   No vuelve a cruzar Catastro (solo si las viviendas/refs
                      no han cambiado y solo quieres refrescar personas).
  --publish           Publica al Portal al terminar (pide login).
  --fecha YYYY-MM-DD  Fecha del padrón en el visor (si no se deduce del nombre).
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_JS = ROOT / "config.js"


def parse_fecha_from_name(name: str) -> str | None:
  """Habitantes a fecha 08_10_26.xlsx → 2026-10-08"""
  m = re.search(r"(\d{1,2})[_\-./](\d{1,2})[_\-./](\d{2,4})", name)
  if not m:
    return None
  d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
  if y < 100:
    y += 2000
  try:
    return date(y, mo, d).isoformat()
  except ValueError:
    return None


def update_fecha_config(fecha: str) -> None:
  text = CONFIG_JS.read_text(encoding="utf-8")
  new_text, n = re.subn(
    r'(fechaPadron\s*:\s*")[^"]*(")',
    rf"\g<1>{fecha}\2",
    text,
    count=1,
  )
  if n != 1:
    raise SystemExit("No se pudo actualizar fechaPadron en config.js")
  CONFIG_JS.write_text(new_text, encoding="utf-8")
  print(f"config.js → fechaPadron: {fecha}", flush=True)


def run(cmd: list[str], step: str) -> None:
  print(f"\n=== {step} ===", flush=True)
  print(">", " ".join(cmd), flush=True)
  proc = subprocess.run(cmd, cwd=str(ROOT))
  if proc.returncode != 0:
    raise SystemExit(f"Falló: {step} (código {proc.returncode})")


def latest_habitantes() -> Path | None:
  files = sorted(
    ROOT.glob("Habitantes*.xlsx"),
    key=lambda p: p.stat().st_mtime,
    reverse=True,
  )
  return files[0] if files else None


def main() -> None:
  parser = argparse.ArgumentParser(
    description="Actualiza el visor con un nuevo fichero de Habitantes",
  )
  parser.add_argument(
    "xlsx",
    nargs="?",
    default="",
    help="Ruta al Excel (si se omite, usa el Habitantes*.xlsx más reciente)",
  )
  parser.add_argument(
    "--skip-enriquecer",
    action="store_true",
    help="Salta el cruce con Catastro (más rápido; solo refresca personas)",
  )
  parser.add_argument(
    "--publish",
    action="store_true",
    help="Al terminar, publica viviendas+personas en el Portal",
  )
  parser.add_argument(
    "--fecha",
    default="",
    help="Fecha del padrón YYYY-MM-DD (si no, se deduce del nombre del fichero)",
  )
  args = parser.parse_args()

  xlsx = Path(args.xlsx) if args.xlsx else latest_habitantes()
  if not xlsx:
    raise SystemExit(
      "No hay Excel. Indica la ruta o deja un fichero Habitantes*.xlsx en la carpeta del proyecto."
    )
  xlsx = xlsx.resolve()
  if not xlsx.exists():
    raise SystemExit(f"No existe: {xlsx}")

  fecha = args.fecha.strip() or parse_fecha_from_name(xlsx.name) or ""
  if not fecha:
    raise SystemExit(
      "No se pudo deducir la fecha del nombre. Usa --fecha YYYY-MM-DD "
      '(p. ej. --fecha 2026-11-15).'
    )

  print(f"Excel: {xlsx}", flush=True)
  print(f"Fecha padrón: {fecha}", flush=True)
  py = sys.executable

  if not args.skip_enriquecer:
    run(
      [py, str(ROOT / "enriquecer_refcat.py"), "--xlsx", str(xlsx)],
      "1/4 Cruzar direcciones con Catastro / portales → padron_refcat.csv",
    )
  else:
    print("\n=== 1/4 enriquecer: OMITIDO (--skip-enriquecer) ===", flush=True)

  run(
    [py, str(ROOT / "build_padron_visor.py"), "--xlsx", str(xlsx)],
    "2/4 Generar viviendas.geojson + personas.json",
  )
  run(
    [py, str(ROOT / "build_chat_stats.py")],
    "3/4 Agregados del chatbot → chat_stats.json",
  )
  print("\n=== 4/4 Fecha en el visor ===", flush=True)
  update_fecha_config(fecha)

  if args.publish:
    run(
      [py, str(ROOT / "publish_portal.py"), "--only", "both"],
      "Publicar capas en el Portal (login)",
    )
  else:
    print(
      "\nListo en local. Para publicar al Portal:\n"
      "  python publish_portal.py\n"
      "o vuelve a ejecutar con --publish",
      flush=True,
    )

  print("\nActualización terminada. Recarga el visor.", flush=True)


if __name__ == "__main__":
  main()
