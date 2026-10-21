#!/usr/bin/env python3
"""Extrae la línea C3 (C3d y C3i) del GTFS de Vitrasa a data/c3.json."""

import csv
import json
import math
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GTFS_URL = "https://datos.vigo.org/data/transporte/gtfs_vigo.zip"
GTFS_DIR = Path("/tmp/vitrasa-gtfs")
OUT = ROOT / "data" / "c3.json"

ROUTES = {"3001": "C3d", "3002": "C3i"}
SMALL = {"por", "de", "del", "da", "do", "das", "dos", "a", "e", "o", "y", "en"}
ACCENTS = (
    ("Garcia", "García"),
    ("Barbon", "Barbón"),
    ("America", "América"),
    ("Travesia", "Travesía"),
)


def nice(text: str) -> str:
    parts = re.sub(r"\s+", " ", text).strip().title().split(" ")
    out = []
    for i, word in enumerate(parts):
        low = word.lower()
        out.append(low if i and low in SMALL else word)
    result = " ".join(out)
    for src, dst in ACCENTS:
        result = result.replace(src, dst)
    return result


def to_sec(value: str) -> int:
    hour, minute, second = (int(part) for part in value.split(":"))
    return hour * 3600 + minute * 60 + second


def meters(a, b) -> float:
    lat = math.radians((a[0] + b[0]) / 2)
    dy = (a[0] - b[0]) * 111_320
    dx = (a[1] - b[1]) * 111_320 * math.cos(lat)
    return math.hypot(dx, dy)


def seg_dist(p, a, b) -> float:
    lat0 = math.radians(a[0])

    def xy(q):
        return (
            (q[1] - a[1]) * 111_320 * math.cos(lat0),
            (q[0] - a[0]) * 111_320,
        )

    px, py = xy(p)
    bx, by = xy(b)
    length = bx * bx + by * by
    if length == 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * bx + py * by) / length))
    return math.hypot(px - t * bx, py - t * by)


def rdp(points, epsilon):
    if len(points) < 3:
        return points
    stack = [(0, len(points) - 1)]
    keep = {0, len(points) - 1}
    while stack:
        start, end = stack.pop()
        max_d = 0.0
        idx = None
        for i in range(start + 1, end):
            d = seg_dist(points[i], points[start], points[end])
            if d > max_d:
                max_d = d
                idx = i
        if idx is not None and max_d > epsilon:
            keep.add(idx)
            stack.append((start, idx))
            stack.append((idx, end))
    return [points[i] for i in sorted(keep)]


def interp(a, b, dist):
    span = b[2] - a[2]
    if span == 0:
        return [a[0], a[1], dist]
    t = (dist - a[2]) / span
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), dist]


def clip_shape(pts, d0, d1):
    if not pts:
        return []
    d0, d1 = (d1, d0) if d1 < d0 else (d0, d1)
    out = []
    for i, point in enumerate(pts):
        dist = point[2]
        if dist < d0:
            continue
        if not out and i > 0 and pts[i - 1][2] < d0:
            out.append(interp(pts[i - 1], point, d0))
        if dist <= d1:
            out.append(list(point))
        else:
            if i > 0:
                out.append(interp(pts[i - 1], point, d1))
            break
    if len(out) >= 2:
        return out
    if pts[-1][2] <= d0:
        return [list(pts[-1]), list(pts[-1])]
    return [list(pts[0]), list(pts[0])]


def load_rows(name):
    with (GTFS_DIR / name).open(newline="") as handle:
        return list(csv.DictReader(handle))


def main():
    if not (GTFS_DIR / "trips.txt").exists():
        print("Falta el GTFS en", GTFS_DIR, file=sys.stderr)
        print("Descárgalo de", GTFS_URL, file=sys.stderr)
        sys.exit(1)

    trips = {}
    for row in load_rows("trips.txt"):
        if row["route_id"] in ROUTES:
            trips[row["trip_id"]] = row

    service_dates = defaultdict(set)
    for row in load_rows("calendar_dates.txt"):
        if row["exception_type"] == "1":
            service_dates[row["service_id"]].add(row["date"])

    def day_kind(service_id):
        dates = service_dates.get(service_id, set())
        if not dates:
            return None
        sample = min(dates)
        # La semana publicada es 2026-10-17 (sábado) a 2026-10-23 (viernes).
        if sample == "20261017" or (len(dates) == 1 and sample.endswith("17")):
            return "S"
        if "20261018" in dates and len(dates) == 1:
            return "D"
        return "L"

    stops = {}
    for row in load_rows("stops.txt"):
        stops[row["stop_id"]] = row

    sequences = defaultdict(list)
    for row in load_rows("stop_times.txt"):
        if row["trip_id"] in trips:
            sequences[row["trip_id"]].append(row)
    for rows in sequences.values():
        rows.sort(key=lambda item: int(item["stop_sequence"]))

    shapes = defaultdict(list)
    needed = {trip["shape_id"] for trip in trips.values()}
    for row in load_rows("shapes.txt"):
        if row["shape_id"] in needed:
            shapes[row["shape_id"]].append(
                (
                    float(row["shape_pt_lat"]),
                    float(row["shape_pt_lon"]),
                    float(row["shape_dist_traveled"]),
                    int(row["shape_pt_sequence"]),
                )
            )
    for shape_id in shapes:
        shapes[shape_id].sort(key=lambda item: item[3])

    groups = defaultdict(list)
    for trip_id, rows in sequences.items():
        trip = trips[trip_id]
        key = (
            trip["route_id"],
            trip["shape_id"],
            trip["trip_headsign"].strip(),
            tuple(row["stop_id"] for row in rows),
        )
        groups[key].append(trip_id)

    stop_index = {}
    stop_list = []

    def stop_id_of(raw_id):
        if raw_id not in stop_index:
            row = stops[raw_id]
            stop_index[raw_id] = len(stop_list)
            code = row["stop_code"][1:] if row["stop_code"].startswith("P") else row["stop_code"]
            if code.startswith("A"):
                code = code[1:]
            code = code.lstrip("0")
            stop_list.append(
                {
                    "n": re.sub(r"\s+", " ", row["stop_name"]).strip(),
                    "lat": round(float(row["stop_lat"]), 5),
                    "lon": round(float(row["stop_lon"]), 5),
                    "code": int(code) if code.isdigit() else None,
                }
            )
        return stop_index[raw_id]

    patterns = []
    for key, trip_ids in groups.items():
        route_id, shape_id, headsign, _stop_ids = key
        sample = sequences[trip_ids[0]]
        d0 = float(sample[0]["shape_dist_traveled"])
        d1 = float(sample[-1]["shape_dist_traveled"])
        raw = [(lat, lon, dist) for lat, lon, dist, _seq in shapes[shape_id]]
        # Garantiza distancias crecientes por si el shape trae un punto repetido.
        cleaned = []
        for point in raw:
            if cleaned and point[2] < cleaned[-1][2]:
                continue
            if cleaned and meters(cleaned[-1], point) < 1 and abs(point[2] - cleaned[-1][2]) < 1:
                continue
            cleaned.append(point)
        clipped = clip_shape(cleaned, d0, d1)
        simplified = rdp(clipped, 6)
        if len(simplified) < 2 and len(clipped) >= 2:
            simplified = [clipped[0], clipped[-1]]

        by_day = {"L": [], "S": [], "D": []}
        for trip_id in trip_ids:
            kind = day_kind(trips[trip_id]["service_id"])
            if kind is None:
                continue
            times = [to_sec(row["arrival_time"]) for row in sequences[trip_id]]
            by_day[kind].append(times)
        for kind in by_day:
            by_day[kind].sort(key=lambda item: item[0])

        total = sum(len(items) for items in by_day.values())
        pattern_stops = []
        for row in sample:
            pattern_stops.append(
                [
                    stop_id_of(row["stop_id"]),
                    round(float(row["shape_dist_traveled"])),
                ]
            )
        patterns.append(
            {
                "line": ROUTES[route_id],
                "head": nice(headsign),
                "from": stop_list[pattern_stops[0][0]]["n"],
                "to": stop_list[pattern_stops[-1][0]]["n"],
                "rare": total <= 2,
                "pts": [
                    [round(lat, 5), round(lon, 5), round(dist)]
                    for lat, lon, dist in simplified
                ],
                "stops": pattern_stops,
                "L": by_day["L"],
                "S": by_day["S"],
                "D": by_day["D"],
            }
        )

    patterns.sort(key=lambda item: (item["line"], item["rare"], item["head"], item["from"]))

    dates = sorted(
        {
            date
            for trip in trips.values()
            for date in service_dates.get(trip["service_id"], ())
        }
    )
    payload = {
        "meta": {
            "agency": "Vitrasa — Viguesa de Transportes S.L.",
            "city": "Vigo",
            "line": "C3",
            "source": "GTFS del Concello de Vigo",
            "sourceUrl": GTFS_URL,
            "license": "Open Data Commons Attribution (atribución: Concello de Vigo)",
            "portal": "https://datos-ckan.vigo.org/dataset/gtfs-vitrasa",
            "timezone": "Europe/Madrid",
            "validFrom": dates[0] if dates else "",
            "validTo": dates[-1] if dates else "",
            "lines": {
                "C3d": "Bouzas / Coia – Encarnación por García Barbón",
                "C3i": "Bouzas / Coia – Encarnación por Travesía de Vigo",
            },
        },
        "stops": stop_list,
        "patterns": patterns,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"{OUT} · {len(stop_list)} paradas · {len(patterns)} recorridos · {OUT.stat().st_size} bytes"
    )


if __name__ == "__main__":
    main()
