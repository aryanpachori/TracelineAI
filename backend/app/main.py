import os
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.extract import extract_rows, statement_text
from app.grade import choose_grade, measure
from app.judge import judge
from app.names import stamp_keys


def load_env() -> None:
    path = Path(__file__).resolve().parents[1] / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://traceline-ai.vercel.app",
    ],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.post("/analyze")
async def analyze(file: UploadFile = File(...), case_ref: str = Form("")):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="The file is empty.")
    if len(raw) > 12_000_000:
        raise HTTPException(status_code=413, detail="The file is too large.")
    name = file.filename or "statement"
    try:
        text = statement_text(name, raw)
        rows = stamp_keys(await extract_rows(text))
        metrics = measure(rows)
        reading = choose_grade(metrics)
        judgment = await judge(rows)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error) or "The statement could not be read.") from error
    return {
        "caseRef": case_ref,
        "fileName": name,
        "rows": rows,
        "reading": reading,
        "metrics": metrics,
        "judgment": judgment,
    }


@app.post("/judge")
async def judge_case(body: dict = Body(...)):
    rows = body.get("rows") if isinstance(body, dict) else None
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=400, detail="The statement rows are missing.")
    sales = _optional_number(body.get("declaredSales"))
    emi = _optional_number(body.get("declaredEmi"))
    stamped = stamp_keys(rows)
    try:
        judgment = await judge(stamped, sales, emi)
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error) or "The file could not be judged.") from error
    return {"rows": stamped, "judgment": judgment}


def _optional_number(value) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
