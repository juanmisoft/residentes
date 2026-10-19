# -*- coding: utf-8 -*-
"""Lotes suaves contra Catastro: prueba, espera y reintenta.

Uso:
  py lote_catastro.py
  py lote_catastro.py --batch 15 --sleep 0.8 --wait 180 --rounds 8
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROBE_URL = (
  "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/"
  "COVCCallejero.svc/json/Consulta_DNPLOC"
)


def probe() -> bool:
  params = {
    "Provincia": "MADRID",
    "Municipio": "RIVAS-VACIAMADRID",
    "Sigla": "CL",
    "Calle": "BEGUINAS",
    "Numero": "2",
  }
  full = PROBE_URL + "?" + urllib.parse.urlencode(params)
  try:
    req = urllib.request.Request(full, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as resp:
      data = json.loads(resp.read().decode("utf-8", errors="replace"))
    return "consulta_dnplocResult" in data
  except Exception as exc:
    print(f"  probe FAIL: {exc}", flush=True)
    return False


def run_batch(batch: int, sleep: float) -> int:
  cmd = [
    sys.executable,
    str(ROOT / "enriquecer_refcat.py"),
    "--max-new",
    str(batch),
    "--sleep",
    str(sleep),
    "--stop-on-net",
    "--retry-failed",
  ]
  print("  →", " ".join(cmd), flush=True)
  completed = subprocess.run(cmd, cwd=str(ROOT))
  return completed.returncode


def main():
  parser = argparse.ArgumentParser(description="Lotes suaves Catastro")
  parser.add_argument("--batch", type=int, default=12, help="Consultas nuevas por lote")
  parser.add_argument("--sleep", type=float, default=0.8, help="Pausa entre consultas")
  parser.add_argument("--wait", type=float, default=180.0, help="Espera si Catastro falla (s)")
  parser.add_argument("--rounds", type=int, default=10, help="Máximo de rondas")
  parser.add_argument("--pause", type=float, default=45.0, help="Pausa entre lotes OK (s)")
  args = parser.parse_args()

  for round_i in range(1, args.rounds + 1):
    print(f"\n=== Ronda {round_i}/{args.rounds} ===", flush=True)
    print("Probe Catastro…", flush=True)
    if not probe():
      print(f"Catastro sigue cortando. Espero {args.wait:.0f}s…", flush=True)
      time.sleep(args.wait)
      continue

    print("Probe OK. Lanzando lote suave…", flush=True)
    code = run_batch(args.batch, args.sleep)
    if code != 0:
      print(f"Lote terminó con código {code}. Espero {args.wait:.0f}s…", flush=True)
      time.sleep(args.wait)
      continue

    print(f"Lote OK. Pausa {args.pause:.0f}s antes del siguiente…", flush=True)
    time.sleep(args.pause)

  print("\nFin de rondas.", flush=True)


if __name__ == "__main__":
  main()
