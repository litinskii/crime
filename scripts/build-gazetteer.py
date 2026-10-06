"""Build a reproducible offline lookup from GeoNames CC BY 4.0 Ukraine dumps.
Usage: python scripts/build-gazetteer.py UA.zip alternate-UA.zip
Only current Ukrainian names and populated places (population >= 1000) are used.
No incident text is sent to GeoNames. Duplicate names remain ambiguous.
"""
import json
import re
import sys
import zipfile
from pathlib import Path

names = {}
for line in zipfile.ZipFile(sys.argv[2]).read("UA.txt").decode().splitlines():
    row = line.split("\t")
    if row[2] == "uk" and row[7] != "1" and not (len(row) > 9 and row[9]):
        names.setdefault(row[1], []).append((row[3], row[4] == "1"))
places = []
for line in zipfile.ZipFile(sys.argv[1]).read("UA.txt").decode().splitlines():
    row = line.split("\t")
    if row[6] != "P" or row[7] == "PPLX" or int(row[14] or 0) < 1000 or row[0] not in names:
        continue
    # GeoNames also tags Latin transliterations as uk; use the Ukrainian script for display.
    variants = sorted(names[row[0]], key=lambda x: (not bool(re.search(r'[А-Яа-яІіЇїЄєҐґ]', x[0])), not x[1], x[0]))
    places.append({"key": "geonames-" + row[0], "uk": variants[0][0], "en": row[2],
                   "latitude": float(row[4]), "longitude": float(row[5]),
                   "precision": "city", "regionCode": row[10],
                   "aliases": sorted(set(x[0] for x in variants))})
out = Path(__file__).resolve().parent.parent / "apps/api/src/ingestion/ukraine-places.json"
out.write_text(json.dumps(places, ensure_ascii=False, separators=(",", ":")) + "\n")
print(f"Wrote {len(places)} populated places to {out}")
