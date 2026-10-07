# -*- coding: utf-8 -*-
import json
import urllib.parse
import urllib.request

BASE = "https://sit.rivasciudad.es/server/rest/services/ACCESOS_PORTALES/FeatureServer/0/query"

def query(params):
    params = dict(params)
    params["f"] = "json"
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))

count = query({"where": "1=1", "returnCountOnly": "true"})
print("count", count)

# How many refs have more than one portal
stats = query({
    "where": "REFCATASTRAL IS NOT NULL",
    "outStatistics": json.dumps([{
        "statisticType": "count",
        "onStatisticField": "OBJECTID",
        "outStatisticFieldName": "N"
    }]),
    "groupByFieldsForStatistics": "REFCATASTRAL",
    "orderByFields": "N DESC",
    "resultRecordCount": 8,
})
feats = stats.get("features", [])
print("groups", len(feats), "sample", feats[:8])

rc = None
if feats:
    rc = feats[0]["attributes"].get("REFCATASTRAL")
print("top rc", rc)
if rc:
    sample = query({
        "where": "REFCATASTRAL='" + rc + "'",
        "outFields": "REFCATASTRAL,ACCESO,PUERTA,ACRDESACC,CALLE,TIPO_VIVIENDA",
        "returnGeometry": "false",
        "resultRecordCount": 25,
    })
    for feature in sample.get("features", []):
        print(feature["attributes"])

# Colibri parcel from padron
col = query({
    "where": "REFCATASTRAL='6244001VK5664S'",
    "outFields": "REFCATASTRAL,ACCESO,PUERTA,ACRDESACC,CALLE,TIPO_VIVIENDA",
    "returnGeometry": "true",
    "outSR": "4326",
})
print("COLIBRI", json.dumps(col.get("features"), ensure_ascii=False)[:800])

mar = query({
    "where": "REFCATASTRAL='6244065VK5664S'",
    "outFields": "REFCATASTRAL,ACCESO,PUERTA,ACRDESACC,CALLE,TIPO_VIVIENDA",
    "returnGeometry": "true",
    "outSR": "4326",
})
print("MARCIAL", json.dumps(mar.get("features"), ensure_ascii=False)[:800])
