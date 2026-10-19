"""Descarga el término municipal y deja solo viviendas y edificios interiores."""
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
URL = (
    "https://sit.rivasciudad.es/server/rest/services/Termino_municipal_actual/FeatureServer/0/query"
    "?where=1%3D1&outFields=NOMBRE&returnGeometry=true&outSR=4326&f=json"
)


def fetch():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def rings_of(geometry):
    if not geometry:
        return []
    if geometry.get("rings"):
        return geometry["rings"]
    return []


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def point_in_polygon(x, y, rings):
    """Esri rings: the first ring is the shell; a ring that contains the point flips membership."""
    if not rings:
        return False
    if not point_in_ring(x, y, rings[0]):
        return False
    for hole in rings[1:]:
        if point_in_ring(x, y, hole):
            return False
    return True


def main():
    payload = fetch()
    features = payload.get("features") or []
    print("features", len(features), "error", payload.get("error"))
    geometries = []
    for feature in features:
        rings = rings_of(feature.get("geometry"))
        attrs = feature.get("attributes") or {}
        print("nombre", attrs.get("NOMBRE"), "rings", len(rings), "verts", sum(len(r) for r in rings))
        geometries.append(rings)

    limite = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"nombre": (feature.get("attributes") or {}).get("NOMBRE")},
                "geometry": {"type": "Polygon", "coordinates": rings_of(feature.get("geometry"))},
            }
            for feature in features
        ],
    }
    (DATA / "limite.json").write_text(json.dumps(limite, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    def inside(lon, lat):
        return any(point_in_polygon(lon, lat, rings) for rings in geometries)

    viviendas = json.loads((DATA / "viviendas.geojson").read_text(encoding="utf-8"))
    kept = []
    outside = 0
    for feature in viviendas["features"]:
        lon, lat = feature["geometry"]["coordinates"][:2]
        if inside(lon, lat):
            kept.append(feature)
        else:
            outside += 1
    print("viviendas", len(viviendas["features"]), "dentro", len(kept), "fuera", outside)

    edificios = json.loads((DATA / "edificios.json").read_text(encoding="utf-8"))
    kept_b = [item for item in edificios if inside(item["lon"], item["lat"])]
    print("edificios", len(edificios), "dentro", len(kept_b), "fuera", len(edificios) - len(kept_b))

    xs = []
    ys = []
    for rings in geometries:
        if not rings:
            continue
        for x, y in rings[0]:
            xs.append(x)
            ys.append(y)
    if xs:
        print("bbox", round(min(xs), 5), round(min(ys), 5), round(max(xs), 5), round(max(ys), 5))


if __name__ == "__main__":
    main()
