"""Read a folder of statements, label what the rules leave open, and teach the narration model.

Image-only files are skipped. Categories stay inside the existing set.
"""

import asyncio
import csv
import json
import logging
import os
import sys
from collections import Counter
from pathlib import Path

import httpx
import joblib

from app.extract import (
    CATEGORIES,
    CLASSIFY_SYSTEM,
    apply_narration_model,
    complete_async,
    parse_statement_rows,
    statement_text,
)
from app.model import NARRATION_PATH

DEFAULT_FOLDER = Path(r"C:\Users\aryan\Downloads\bank-statements")
TEACHER = Path(__file__).resolve().parents[1] / "data" / "learn" / "teacher.csv"


def load_env() -> None:
    path = Path(__file__).resolve().parents[1] / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def bank_hint(text: str) -> str:
    head = text[:1500].lower()
    for name in ("hdfc", "icici", "axis", "state bank", "sbi", "kotak", "yes bank", "indusind", "idfc", "punjab national", "bank of baroda", "union bank", "canara", "federal", "rbl", "au small", "bandhan", "paytm"):
        if name in head:
            return name
    return "unknown"


async def label_open(pending: list[dict]) -> dict[int, str]:
    labelled: dict[int, str] = {}
    if not pending:
        return labelled
    async with httpx.AsyncClient(timeout=90) as client:
        for start in range(0, len(pending), 24):
            chunk = pending[start:start + 24]
            try:
                data = await complete_async(client, CLASSIFY_SYSTEM, "Label each narration:\n" + json.dumps({"rows": chunk}))
            except (httpx.HTTPError, RuntimeError, ValueError, KeyError, TypeError) as exc:
                print(f"label chunk failed: {exc}", file=sys.stderr)
                continue
            for item in data.get("labels") or []:
                if not isinstance(item, dict):
                    continue
                category = str(item.get("category") or "")
                try:
                    index = int(item.get("i"))
                except (TypeError, ValueError):
                    continue
                if category in CATEGORIES:
                    labelled[index] = category
            print(f"labelled {min(start + 24, len(pending))}/{len(pending)}", flush=True)
    return labelled


def already_taught() -> set[tuple[str, str]]:
    if not TEACHER.exists():
        return set()
    known: set[tuple[str, str]] = set()
    with TEACHER.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            text = str(row.get("text") or "").strip().lower()
            category = str(row.get("category") or "")
            if text and category:
                known.add((text, category))
    return known


def teach(pairs: list[tuple[str, str]]) -> int:
    if not pairs:
        return 0
    bundle = joblib.load(NARRATION_PATH)
    classifier = bundle["classifier"]
    vectorizer = bundle["vectorizer"]
    known = set(classifier.classes_)
    seen = already_taught()
    usable = []
    for text, label in pairs:
        key = (text.strip().lower(), label)
        if label not in known or key in seen:
            continue
        seen.add(key)
        usable.append((text, label))
    if not usable:
        return 0
    TEACHER.parent.mkdir(parents=True, exist_ok=True)
    new = not TEACHER.exists()
    with TEACHER.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        if new:
            writer.writerow(["text", "category"])
        writer.writerows(usable)
    classifier.class_weight = None
    vector = vectorizer.transform([text for text, _ in usable])
    classifier.partial_fit(vector, [label for _, label in usable])
    bundle["learned"] = int(bundle.get("learned") or 0) + len(usable)
    temporary = NARRATION_PATH.with_suffix(".joblib.tmp")
    joblib.dump(bundle, temporary)
    temporary.replace(NARRATION_PATH)
    return len(usable)


async def main() -> None:
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    load_env()
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_FOLDER
    report_path = TEACHER.parent / f"{folder.name}-report.json"
    files = sorted(folder.glob("*.pdf")) + sorted(folder.glob("*.PDF"))
    seen = set()
    unique_files = []
    for path in files:
        key = str(path.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        unique_files.append(path)

    banks: Counter[str] = Counter()
    skipped: list[dict] = []
    thin: list[str] = []
    open_map: dict[str, dict] = {}
    labelled_local = 0
    row_count = 0
    for path in unique_files:
        try:
            text = statement_text(path.name, path.read_bytes())
            rows = parse_statement_rows(text)
        except (ValueError, OSError, RuntimeError) as exc:
            skipped.append({"file": path.name, "reason": str(exc)})
            continue
        except Exception as exc:
            skipped.append({"file": path.name, "reason": f"{type(exc).__name__}: {exc}"})
            continue
        banks[bank_hint(text)] += 1
        if len(rows) < 5:
            thin.append(path.name)
            continue
        row_count += len(rows)
        for row in rows:
            apply_narration_model(row)
            if row.get("_open"):
                key = row["description"].strip().lower()[:180]
                slot = open_map.setdefault(key, {"side": "credit" if row["credit"] else "debit", "amount": 0.0, "count": 0})
                slot["amount"] += row["credit"] or row["debit"]
                slot["count"] += 1
            else:
                labelled_local += 1
        print(f"{path.name[:8]} rows {len(rows)}", flush=True)

    ranked = sorted(open_map.items(), key=lambda item: item[1]["amount"], reverse=True)[:240]
    pending = [
        {"i": index, "side": item[1]["side"], "narration": item[0]}
        for index, item in enumerate(ranked)
    ]
    labels = await label_open(pending)
    pairs = []
    taught_counts: Counter[str] = Counter()
    for index, category in labels.items():
        narration = pending[index]["narration"]
        side = pending[index]["side"]
        pairs.append((f"{side} {narration}", category))
        taught_counts[category] += 1
    learned = teach(pairs)
    report = {
        "folder": str(folder),
        "files": len(unique_files),
        "skipped": len(skipped),
        "thin": len(thin),
        "rows": row_count,
        "labelled_local": labelled_local,
        "open_unique": len(open_map),
        "asked_model": len(pending),
        "learned": learned,
        "banks": dict(banks),
        "taught": dict(taught_counts),
        "skip_reasons": Counter(item["reason"] for item in skipped).most_common(),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
