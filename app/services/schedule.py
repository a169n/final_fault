from __future__ import annotations

from typing import Any, Dict, Iterator, List, Optional

DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri")
HOURS = ("09", "11", "14", "16")
SLOTS = [f"{d}-{h}" for d in DAYS for h in HOURS]

Placements = Dict[str, Optional[List[str]]]


def place(course: Dict[str, Any], rooms: List[Dict[str, Any]], placed: Placements,
          teacher_of: Dict[str, str]) -> Optional[List[str]]:
    taken = {tuple(p) for p in placed.values() if p}
    teacher_busy = {p[0] for cid, p in placed.items() if p and teacher_of[cid] == course["teacher"]}
    for slot in SLOTS:
        if slot in teacher_busy:
            continue
        for room in rooms:
            if room["capacity"] >= course["students"] and (slot, room["id"]) not in taken:
                return [slot, room["id"]]
    return None


def steps(courses: List[Dict[str, Any]], rooms: List[Dict[str, Any]], placed: Placements) -> Iterator[str]:
    teacher_of = {c["id"]: c["teacher"] for c in courses}
    rooms = sorted(rooms, key=lambda r: (r["capacity"], r["id"]))
    for course in sorted(courses, key=lambda c: (-c["students"], c["id"])):
        if course["id"] in placed:
            continue
        placed[course["id"]] = place(course, rooms, placed, teacher_of)
        yield course["id"]
