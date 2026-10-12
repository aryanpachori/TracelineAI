import os
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.extract import extract_rows, statement_text
from app.grade import choose_grade, measure


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
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
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
        rows = extract_rows(text)
        metrics = measure(rows)
        reading = choose_grade(metrics)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error) or "The statement could not be read.") from error
    return {"caseRef": case_ref, "fileName": name, "rows": rows, "reading": reading, "metrics": metrics}
