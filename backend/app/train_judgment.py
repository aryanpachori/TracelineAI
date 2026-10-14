"""Train the party matcher and the loop matcher.

Party pairs come from the narration supplement: the same entity written on
different rails is a match, and two different entities are not. Loop pairs
come from self-transfers and from rows the loan-underwriting set marks as
window dressing, against ordinary buyer-to-supplier payments.

The accept and review band is chosen on the holdout. It is stored with the
model, so the judge does not carry a fixed cutoff.
"""

import csv
import io
import json
import random
import zipfile
from collections import defaultdict
from pathlib import Path

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import SGDClassifier
from sklearn.model_selection import train_test_split

from app.model import LOOP_LEARN, LOOP_PATH, PARTY_LEARN, PARTY_PATH, loop_text, party_text
from app.names import display_name
from app.train import DATA, gap_rows

ROOT = Path(__file__).resolve().parents[1]
LABELS = ROOT / "app" / "labels.json"
CAP = 2500


def main() -> None:
    party_rows = party_examples()
    loop_rows = loop_examples()
    print(f"party pairs {len(party_rows)}")
    print(f"loop pairs {len(loop_rows)}")
    train_one(party_rows, party_text, "same", PARTY_PATH, char=True)
    train_one(loop_rows, loop_text, "loop", LOOP_PATH, char=False)
    check()


def party_examples() -> list[tuple[str, str, str]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    for narration, _category in gap_rows():
        name = display_name(narration)
        if name:
            grouped[name].append(name)
            grouped[name].extend(variants(name))
    for narration, label in label_rows():
        if label == "window_dressing":
            continue
        name = display_name(narration)
        if name:
            grouped[name].append(name)
            grouped[name].extend(variants(name))
    for name, forms in ledger_names().items():
        grouped[name].extend(forms)

    names = [name for name, forms in grouped.items() if forms]
    rows: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    def push(a: str, b: str, label: str) -> None:
        if not a or not b or a.lower() == b.lower() or len(rows) >= CAP * 2:
            return
        key = (party_text(a, b), label)
        if key in seen:
            return
        seen.add(key)
        rows.append((a, b, label))

    for name, forms in grouped.items():
        unique = list(dict.fromkeys(forms))
        for form in unique:
            push(name, form, "same")
            if len(unique) > 1:
                push(unique[0], form, "same")
    for index, left in enumerate(names):
        for right in names[index + 1:index + 6]:
            push(left, right, "different")
            push(variants(left)[-1], right, "different")
    for left, right, label in read_learned(PARTY_LEARN):
        push(left, right, label)
    return rows


def loop_examples() -> list[tuple[str, str, str]]:
    by_cat: dict[str, list[str]] = defaultdict(list)
    for narration, category in gap_rows():
        by_cat[category].append(narration)
    rows: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str]] = set()

    def push(credit: str, debit: str, label: str) -> None:
        if not credit or not debit or len(rows) >= CAP * 2:
            return
        key = (loop_text(credit, debit), label)
        if key in seen:
            return
        seen.add(key)
        rows.append((credit, debit, label))

    people = ["RAVI", "MEENA", "OWNER", "PARTNER"]
    for person in people:
        incoming = [item for item in by_cat["self_in"] + by_cat["transfer_in"] if person in item]
        outgoing = [item for item in by_cat["self_out"] + by_cat["transfer_out"] if person in item]
        for credit in incoming:
            for debit in outgoing:
                push(credit, debit, "loop")
    for narration, label in label_rows():
        if label == "window_dressing":
            for debit in by_cat["transfer_out"][:8]:
                push(narration, debit, "loop")
            for debit in by_cat["self_out"][:4]:
                push(narration, debit, "loop")
    buyers = by_cat["business_in"]
    mills = by_cat["supplier"]
    for credit in buyers[:40]:
        for debit in mills[:8]:
            push(credit, debit, "keep")
    for credit in by_cat["salary"][:12]:
        for debit in by_cat["emi"][:8]:
            push(credit, debit, "keep")
    for credit, debit, label in ledger_loops():
        push(credit, debit, label)
    for left, right, label in read_learned(LOOP_LEARN):
        push(left, right, label)
    return rows


def variants(name: str) -> list[str]:
    forms = [name]
    if len(name) >= 8:
        start = max(6, int(len(name) * 0.55))
        for size in range(start, len(name)):
            forms.append(name[:size].rstrip())
    return list(dict.fromkeys(form for form in forms if len(form) >= 4))


def label_rows() -> list[tuple[str, str]]:
    if not LABELS.exists():
        return []
    payload = json.loads(LABELS.read_text(encoding="utf-8"))
    rows = []
    for item in payload.get("examples") or []:
        narration = str(item.get("narration") or "").strip()
        label = str(item.get("kaggleLabel") or "").strip().lower()
        if narration and label:
            rows.append((narration, label))
    return rows


def ledger_names() -> dict[str, list[str]]:
    grouped: dict[str, set[str]] = defaultdict(set)
    for row in ledger_sample():
        if row["true_category"] in {"window_dressing", "bounce"}:
            continue
        name = display_name(row["narration_raw"])
        if name:
            grouped[name].add(name)
            grouped[name].update(variants(name))
    return {name: list(forms) for name, forms in grouped.items()}


def ledger_loops() -> list[tuple[str, str, str]]:
    by_customer: dict[str, list[dict]] = defaultdict(list)
    for row in ledger_sample():
        by_customer[row["customer_id"]].append(row)
    pairs = []
    for rows in by_customer.values():
        credits = [row for row in rows if row["direction"] == "credit"]
        debits = [row for row in rows if row["direction"] == "debit"]
        for credit in credits:
            if credit["true_category"] != "window_dressing":
                continue
            for debit in debits:
                if debit["true_category"] in {"emi", "rent", "utilities"}:
                    pairs.append((credit["narration_raw"], debit["narration_raw"], "keep"))
                elif debit["true_category"] in {"window_dressing", "discretionary"} or "TRANSFER" in debit["narration_raw"].upper():
                    pairs.append((credit["narration_raw"], debit["narration_raw"], "loop"))
        business = [row for row in credits if row["true_category"] == "business_income"]
        suppliers = [row for row in debits if "PURCHASE" in row["narration_raw"].upper() or row["true_category"] == "business_income"]
        for credit in business[:3]:
            for debit in suppliers[:3]:
                if credit["narration_raw"] != debit["narration_raw"]:
                    pairs.append((credit["narration_raw"], debit["narration_raw"], "keep"))
    return pairs


def ledger_sample() -> list[dict]:
    path = DATA / "loan-underwriting.zip"
    if not path.exists():
        return []
    rows = []
    with zipfile.ZipFile(path) as archive:
        with archive.open("transaction_ledger.csv") as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))
            for row in reader:
                rows.append(row)
                if len(rows) >= 40000:
                    break
    return rows


def read_learned(path: Path) -> list[tuple[str, str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        return [
            (row["left"], row["right"], row["label"])
            for row in csv.DictReader(handle)
            if row.get("left") and row.get("right") and row.get("label")
        ]


def train_one(rows: list[tuple[str, str, str]], text_of, positive: str, path: Path, char: bool) -> None:
    if len(rows) < 30:
        print(f"skipped {path.name}, not enough pairs")
        return
    texts = [text_of(a, b) for a, b, _ in rows]
    labels = [label for _, _, label in rows]
    train_x, test_x, train_y, test_y = train_test_split(
        texts, labels, test_size=0.2, random_state=7, stratify=labels
    )
    if char:
        vectorizer = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), min_df=1, max_features=30000)
    else:
        vectorizer = TfidfVectorizer(ngram_range=(1, 2), min_df=1, max_features=30000)
    classifier = SGDClassifier(loss="log_loss", alpha=1e-5, class_weight="balanced", random_state=7)
    classifier.fit(vectorizer.fit_transform(train_x), train_y)
    probs = positive_column(classifier, vectorizer.transform(test_x), positive)
    low, high = fit_band(probs, test_y, positive)
    called = 0
    correct = 0
    for prob, label in zip(probs, test_y):
        if prob >= high:
            guess = positive
        elif prob <= low:
            guess = other_label(positive)
        else:
            continue
        called += 1
        correct += guess == label
    print(
        f"{path.name} holdout decided {called}/{len(test_y)}"
        f" accuracy {correct / called if called else 0:.3f} band {low:.2f}-{high:.2f}"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {"vectorizer": vectorizer, "classifier": classifier, "low": low, "high": high, "learned": 0},
        path,
    )


def positive_column(classifier, vector, label: str) -> list[float]:
    probs = classifier.predict_proba(vector)
    column = list(classifier.classes_).index(label)
    return [float(row[column]) for row in probs]


def other_label(positive: str) -> str:
    return "different" if positive == "same" else "keep"


def fit_band(probs: list[float], labels: list[str], positive: str) -> tuple[float, float]:
    best_t = 0.5
    best_f1 = -1.0
    for step in range(5, 96):
        threshold = step / 100
        true_pos = false_pos = false_neg = 0
        for prob, label in zip(probs, labels):
            called = prob >= threshold
            is_pos = label == positive
            if called and is_pos:
                true_pos += 1
            elif called and not is_pos:
                false_pos += 1
            elif is_pos and not called:
                false_neg += 1
        precision = true_pos / (true_pos + false_pos) if true_pos + false_pos else 0
        recall = true_pos / (true_pos + false_neg) if true_pos + false_neg else 0
        f1 = (2 * precision * recall / (precision + recall)) if precision + recall else 0
        if f1 > best_f1:
            best_f1 = f1
            best_t = threshold
    gaps = sorted(abs(prob - best_t) for prob in probs)
    band = gaps[max(0, int(len(gaps) * 0.1) - 1)] if gaps else 0.0
    return max(0.0, best_t - band), min(1.0, best_t + band)


def check() -> None:
    from app.model import predict_loop, predict_party

    global_reset()
    probes = [
        ("RAJESH MILLS", "RAJESH MILLS", "same"),
        ("SHAH WHOLESALE", "SHAH WHOL", "same"),
        ("SHAH WHOLESALE", "RAJESH MILLS", "different"),
        ("PATEL FABRICS", "PATEL FAB", "same"),
    ]
    for left, right, _expected in probes:
        print("party", predict_party(left, right), left, "|", right)
    print(
        "loop",
        predict_loop("NEFT/SELF TRF FROM SAVINGS RAVI", "NEFT/SELF TRF TO SAVINGS RAVI"),
    )
    print(
        "keep",
        predict_loop("NEFT/SHAH WHOLESALE/INVOICE", "NEFT/RAJESH MILLS/PURCHASE"),
    )


def global_reset() -> None:
    import app.model as model

    model._party = None
    model._loop = None
    random.seed(7)


if __name__ == "__main__":
    main()
