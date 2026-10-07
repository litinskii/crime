"""Build a reproducible offline lookup from GeoNames CC BY 4.0 Ukraine dumps.
Usage: python scripts/build-gazetteer.py UA.zip alternate-UA.zip
Current Ukrainian names and populated places >= 1000 are used nationally.
Smaller settlements in the five pilot oblasts and Lviv are stored separately
as compact tuples to stay within the Worker Free bundle size.
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
rural = []
pilot_regions = {"23", "19", "24", "03", "27", "15"}
for line in zipfile.ZipFile(sys.argv[1]).read("UA.txt").decode().splitlines():
    row = line.split("\t")
    if row[6] != "P" or row[7] == "PPLX" or row[0] not in names:
        continue
    # GeoNames also tags Latin transliterations as uk; use the Ukrainian script for display.
    variants = sorted(names[row[0]], key=lambda x: (not bool(re.search(r'[А-Яа-яІіЇїЄєҐґ]', x[0])), not x[1], x[0]))
    if int(row[14] or 0) < 1000:
        if row[10] in pilot_regions and re.search(r'[А-Яа-яІіЇїЄєҐґ]', variants[0][0]):
            rural.append([row[0], variants[0][0], row[2], float(row[4]), float(row[5]),
                          row[10], sorted(set(x[0] for x in variants if x[0] not in (variants[0][0], row[2])))])
        continue
    places.append({"key": "geonames-" + row[0], "uk": variants[0][0], "en": row[2],
                   "latitude": float(row[4]), "longitude": float(row[5]),
                   "precision": "city", "regionCode": row[10],
                   "aliases": sorted(set(x[0] for x in variants))})
out = Path(__file__).resolve().parent.parent / "apps/api/src/ingestion/ukraine-places.json"
out.write_text(json.dumps(places, ensure_ascii=False, separators=(",", ":")) + "\n")
print(f"Wrote {len(places)} populated places to {out}")
out = out.with_name("ukraine-rural-places.json")
out.write_text(json.dumps(rural, ensure_ascii=False, separators=(",", ":")) + "\n")
print(f"Wrote {len(rural)} regional small settlements to {out}")
