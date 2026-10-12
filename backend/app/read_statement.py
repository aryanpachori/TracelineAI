import asyncio
import json
import sys
import traceback
from pathlib import Path

from app.extract import extract_rows, statement_text
from app.grade import choose_grade, measure
from app.main import load_env


async def read_statement(path: Path) -> Path:
    raw = path.read_bytes()
    text = statement_text(path.name, raw)
    rows = await extract_rows(text)
    metrics = measure(rows)
    reading = choose_grade(metrics)
    out = path.with_suffix(".credit.json")
    out.write_text(
        json.dumps(
            {"fileName": path.name, "rows": rows, "reading": reading, "metrics": metrics},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"rows {len(rows)} grade {reading.get('letter')} {reading.get('points')} -> {out.name}", flush=True)
    return out


def main() -> None:
    load_env()
    path = Path(sys.argv[1])
    try:
        asyncio.run(read_statement(path))
    except Exception:
        traceback.print_exc()
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
