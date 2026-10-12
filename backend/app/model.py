import csv
import threading
from pathlib import Path

import joblib

ROOT = Path(__file__).resolve().parents[1]
NARRATION_PATH = ROOT / "models" / "narration.joblib"
GRADE_PATH = ROOT / "models" / "grade.joblib"
LEARN_PATH = ROOT / "data" / "learn" / "teacher.csv"
TRUST = 0.72
TEACH_BELOW = 0.58
BATCH = 40

_lock = threading.Lock()
_narration = None
_grade = None
_pending: list[tuple[str, str]] = []
_known: set[str] = set()


def predict_category(narration: str, debit: float, credit: float) -> tuple[str, float] | None:
    bundle = _load_narration()
    if bundle is None or not narration.strip():
        return None
    side = "credit" if credit > debit else "debit"
    vector = bundle["vectorizer"].transform([f"{side} {narration}"])
    probs = bundle["classifier"].predict_proba(vector)[0]
    index = int(probs.argmax())
    return str(bundle["classifier"].classes_[index]), float(probs[index])


def predict_grade(metrics: dict) -> str | None:
    bundle = _load_grade()
    if bundle is None:
        return None
    row = [[float(metrics.get(name) or 0) for name in bundle["features"]]]
    return str(bundle["classifier"].predict(row)[0])


def learn_from_teacher(narration: str, category: str, debit: float, credit: float, confidence: float) -> None:
    if confidence >= TEACH_BELOW or not narration.strip():
        return
    bundle = _load_narration()
    if bundle is None or category not in set(bundle["classifier"].classes_):
        return
    side = "credit" if credit > debit else "debit"
    text = f"{side} {narration.strip()}"
    key = text.lower()
    with _lock:
        if key in _known:
            return
        _known.add(key)
        _pending.append((text, category))
        _append(text, category)
        if len(_pending) < BATCH:
            return
        batch = _pending[:BATCH]
        del _pending[:BATCH]
        classifier = bundle["classifier"]
        vector = bundle["vectorizer"].transform([item[0] for item in batch])
        classifier.partial_fit(vector, [item[1] for item in batch])
        bundle["learned"] = int(bundle.get("learned") or 0) + len(batch)
        joblib.dump(bundle, NARRATION_PATH)


def _append(text: str, category: str) -> None:
    LEARN_PATH.parent.mkdir(parents=True, exist_ok=True)
    new = not LEARN_PATH.exists()
    with LEARN_PATH.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        if new:
            writer.writerow(["text", "category"])
        writer.writerow([text, category])


def _load_narration():
    global _narration
    if _narration is not None:
        return _narration
    if not NARRATION_PATH.exists():
        return None
    with _lock:
        if _narration is None:
            _narration = joblib.load(NARRATION_PATH)
    return _narration


def _load_grade():
    global _grade
    if _grade is not None:
        return _grade
    if not GRADE_PATH.exists():
        return None
    _grade = joblib.load(GRADE_PATH)
    return _grade
