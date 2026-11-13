from __future__ import annotations

from fastapi.responses import JSONResponse

from .. import fault_injection
from ..core.db import db_healthy, read, to_jsonable
from ..core.eventlog import ft_enabled
from ..core.service import create_app
from ..fault_tolerance.software.degradation import StaleCache

app = create_app()
app.include_router(fault_injection.router)

_cache = StaleCache()


@app.get("/health/ready")
@app.get("/health")  # alias of /health/ready: the midterm harness probes /health
async def health():
    ok = await db_healthy()
    healthy = ok or ft_enabled()  # FT: the cache can still answer
    return JSONResponse(status_code=200 if healthy else 503,
                        content={"ok": ok, "degraded": not ok, "ft": ft_enabled()})


@app.get("/{student_id}")
async def transcript(student_id: str):
    await fault_injection.chaos_gate()
    try:
        rows = await read(
            "SELECT course, grade FROM grades WHERE student_id = %s ORDER BY course", (student_id,)
        )
        gpa = round(sum(float(r["grade"]) for r in rows) / len(rows), 2) if rows else 0
        body = {"studentId": student_id, "courses": to_jsonable(rows), "gpa": gpa}
        _cache.remember(student_id, body)
        return body
    except Exception:
        stale = _cache.fallback(student_id, "transcript")   # S7
        if stale is None:
            raise
        return stale
