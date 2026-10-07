# -*- coding: utf-8 -*-
import csv
import json
import urllib.parse
import urllib.request
from collections import Counter

BASE = "https://sit.rivasciudad.es/server/rest/services/ACCESOS_PORTALES/FeatureServer/0/query"
RC = "6063601VK5666S"

def query(params):
    params = dict(params)
    params["f"] = "json"
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))

data = query({
    "where": "REFCATASTRAL='" + RC + "'",
    "outFields": "ACCESO,PUERTA,ACRDESACC,CALLE",
    "returnGeometry": "false",
    "resultRecordCount": 30,
})
print("portales sample", len(data.get("features", [])))
accesos = Counter()
puertas = Counter()
for feature in data.get("features", []):
    a = feature["attributes"]
    accesos[a.get("ACCESO")] += 1
    puertas[(a.get("PUERTA") or "").strip()] += 1
    if len(accesos) <= 15:
        print(a)

print("acceso kinds in page", accesos.most_common(10))
print("puerta kinds", puertas.most_common(10))

print("--- csv ---")
with open("Padron_por_Portal_Piso_y_Puerta.csv", encoding="latin1", newline="") as handle:
    reader = csv.DictReader(handle, delimiter=";")
    n = 0
    portals = Counter()
    vias = Counter()
    for row in reader:
        rc = (row.get("ReferenciaCatastral") or "").strip()[:14]
        if rc != RC:
            continue
        n += 1
        portals[(row.get("PORTAL") or "").strip()] += 1
        vias[(row.get("VIA_NUMERO") or "").strip()] += 1
print("csv rows", n)
print("portals", portals.most_common(8))
print("vias", vias.most_common(5))
