# -*- coding: utf-8 -*-
import json
import urllib.request

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=40) as resp:
        return json.loads(resp.read().decode("utf-8"))

portal = "https://sit.rivasciudad.es/server/rest/services/ACCESOS_PORTALES/FeatureServer/0"
parcela = "https://sit.rivasciudad.es/server/rest/services/PARCELAS_CATASTRALES_URBANA/FeatureServer/0"

for name, url in (("PORTALES", portal), ("PARCELAS", parcela)):
    data = get(url + "?f=json")
    print("====", name, data.get("geometryType"), "max", data.get("maxRecordCount"))
    for field in data.get("fields", []):
        print(f"  {field['name']:24} {field['type']:26} {field.get('alias')}")

sample = get(
    portal
    + "/query?where=1%3D1&outFields=*&returnGeometry=true&resultRecordCount=3&f=json&outSR=4326"
)
print("---- sample portal ----")
print(json.dumps(sample.get("features", [])[:2], ensure_ascii=False)[:2000])
