"""Clasifica parcelas del padrón que parecen unifamiliares y se pintan como bloque."""
import json
from collections import Counter, defaultdict
from pathlib import Path

geo = json.loads(Path("data/viviendas.geojson").read_text(encoding="utf-8"))
by_rc = defaultdict(list)
for feature in geo["features"]:
    props = feature["properties"]
    by_rc[props["rc"]].append(props)

multi = {rc: rows for rc, rows in by_rc.items() if len(rows) > 1}
print("plurifamiliares", len(multi), "unifamiliares", len(by_rc) - len(multi))

def signature(rows):
    plants = tuple(sorted({row["planta"] for row in rows}))
    letters = tuple(sorted({row["letra"] or "" for row in rows}))
    dirs = tuple(sorted({row["direccion"] for row in rows}))
    return (len(rows), len(dirs), plants, letters, len(dirs) == 1)

buckets = Counter()
examples = defaultdict(list)
for rc, rows in multi.items():
    n, nd, plants, letters, same = signature(rows)
    empty_floor = all(p in ("", "Sin planta", "Unifamiliar") for p in plants)
    one_floor = len(plants) == 1
    key = (
        "same_addr" if same else "multi_addr",
        "n" + str(n if n < 6 else "6+"),
        "no_floor" if empty_floor else ("one_floor" if one_floor else "many_floors"),
        "no_letter" if letters == ("",) else "letters",
    )
    buckets[key] += 1
    if len(examples[key]) < 3:
        examples[key].append((rc, rows[0]["direccion"], n, plants, letters))

for key, count in buckets.most_common():
    print(f"{count:5}  {key}")
    for item in examples[key]:
        print("       ", item)
