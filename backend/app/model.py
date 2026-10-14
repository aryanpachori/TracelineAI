import csv
import threading
from pathlib import Path

import joblib

ROOT = Path(__file__).resolve().parents[1]
NARRATION_PATH = ROOT / "models" / "narration.joblib"
GRADE_PATH = ROOT / "models" / "grade.joblib"
PARTY_PATH = ROOT / "models" / "party.joblib"
LOOP_PATH = ROOT / "models" / "loop.joblib"
LEARN_PATH = ROOT / "data" / "learn" / "teacher.csv"
PARTY_LEARN = ROOT / "data" / "learn" / "parties.csv"
LOOP_LEARN = ROOT / "data" / "learn" / "loops.csv"
TRUST = 0.72
TEACH_BELOW = 0.58
BATCH = 40

_lock = threading.Lock()
_narration = None
_grade = None
_party = None
_loop = None
_pending: list[tuple[str, str]] = []
_known: set[str] = set()
_learned_pairs: set[tuple[str, str, str, str]] | None = None


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
        try:
            classifier.partial_fit(vector, [item[1] for item in batch])
            bundle["learned"] = int(bundle.get("learned") or 0) + len(batch)
            joblib.dump(bundle, NARRATION_PATH)
        except (OSError, ValueError):
            return


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


def party_text(a: str, b: str) -> str:
    left, right = sorted((a.strip().lower(), b.strip().lower()))
    return f"{left} || {right}"


def loop_text(credit: str, debit: str) -> str:
    return f"in {credit.strip().lower()} || out {debit.strip().lower()}"


def predict_party(a: str, b: str) -> str:
    decided = predict_party_many([(a, b)])
    return decided[0] if decided else "open"


def predict_party_many(pairs: list[tuple[str, str]]) -> list[str]:
    bundle = _load_party()
    if bundle is None or not pairs:
        return ["open"] * len(pairs)
    probs = _positive(bundle, [party_text(a, b) for a, b in pairs], "same")
    return [_band(bundle, prob) for prob in probs]


def predict_loop(credit: str, debit: str) -> str:
    decided = predict_loop_many([(credit, debit)])
    return decided[0] if decided else "open"


def predict_loop_many(pairs: list[tuple[str, str]]) -> list[str]:
    bundle = _load_loop()
    if bundle is None or not pairs:
        return ["open"] * len(pairs)
    probs = _positive(bundle, [loop_text(credit, debit) for credit, debit in pairs], "loop")
    decided = []
    for prob in probs:
        if prob >= float(bundle["high"]):
            decided.append("loop")
        elif prob <= float(bundle["low"]):
            decided.append("keep")
        else:
            decided.append("open")
    return decided


def learn_parties(pairs: list[tuple[str, str, str]]) -> None:
    _learn_pairs(PARTY_PATH, _load_party, "_party", PARTY_LEARN, pairs, party_text, ("same", "different"))


def learn_loops(pairs: list[tuple[str, str, str]]) -> None:
    _learn_pairs(LOOP_PATH, _load_loop, "_loop", LOOP_LEARN, pairs, loop_text, ("loop", "keep"))


def _positive(bundle: dict, texts: list[str], label: str) -> list[float]:
    vector = bundle["vectorizer"].transform(texts)
    probs = bundle["classifier"].predict_proba(vector)
    classes = list(bundle["classifier"].classes_)
    if label not in classes:
        return [0.0] * len(texts)
    column = classes.index(label)
    return [float(row[column]) for row in probs]


def _band(bundle: dict, prob: float) -> str:
    if prob >= float(bundle["high"]):
        return "same"
    if prob <= float(bundle["low"]):
        return "different"
    return "open"


def _learn_pairs(path: Path, loader, slot: str, learn_path: Path, pairs: list[tuple[str, str, str]], text_of, allowed: tuple[str, str]) -> None:
    clean = []
    for a, b, label in pairs:
        a, b = a.strip(), b.strip()
        if not a or not b or label not in allowed or _remembered(learn_path, a, b, label):
            continue
        clean.append((a, b, label))
    if not clean:
        return
    _append_pairs(learn_path, clean)
    bundle = loader()
    if bundle is None:
        return
    with _lock:
        try:
            bundle["classifier"].partial_fit(
                bundle["vectorizer"].transform([text_of(a, b) for a, b, _ in clean]),
                [label for _, _, label in clean],
            )
            bundle["learned"] = int(bundle.get("learned") or 0) + len(clean)
            joblib.dump(bundle, path)
            globals()[slot] = bundle
        except (OSError, ValueError):
            return


def _remembered(path: Path, left: str, right: str, label: str) -> bool:
    global _learned_pairs
    if _learned_pairs is None:
        found: set[tuple[str, str, str, str]] = set()
        for learn_path in (PARTY_LEARN, LOOP_LEARN):
            if not learn_path.exists():
                continue
            with learn_path.open(encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle):
                    if row.get("left") and row.get("right") and row.get("label"):
                        found.add((learn_path.name, row["left"].strip().lower(), row["right"].strip().lower(), row["label"]))
        _learned_pairs = found
    key = (path.name, left.lower(), right.lower(), label)
    if key in _learned_pairs:
        return True
    _learned_pairs.add(key)
    return False


def _append_pairs(path: Path, pairs: list[tuple[str, str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        if new:
            writer.writerow(["left", "right", "label"])
        writer.writerows(pairs)


def _load_party():
    global _party
    if _party is not None:
        return _party
    if not PARTY_PATH.exists():
        return None
    with _lock:
        if _party is None:
            _party = joblib.load(PARTY_PATH)
    return _party


def _load_loop():
    global _loop
    if _loop is not None:
        return _loop
    if not LOOP_PATH.exists():
        return None
    with _lock:
        if _loop is None:
            _loop = joblib.load(LOOP_PATH)
    return _loop
