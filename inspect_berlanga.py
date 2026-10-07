# -*- coding: utf-8 -*-
import json
import urllib.parse
import urllib.request
from collections import Counter

BASE = "https://sit.rivasciudad.es/server/rest/services/ACCESOS_PORTALES/FeatureServer/0/query"
RC = "5872209VK5657S"

def query(where, fields="ACCESO,PUERTA,ACRDESACC,CALLE"):
    params = {
        "where": where,
        "outFields": fields,
        "returnGeometry": "false",
        "resultRecordCount": 40,
        "f": "json",
    }
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))

data = query("REFCATASTRAL='" + RC + "'")
print("n", len(data.get("features", [])))
for feature in data.get("features", [])[:20]:
    print(feature["attributes"])
