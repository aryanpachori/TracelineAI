"""Train the narration classifier and the grade model.

The narration model learns Kaggle statement text, plus a supplement for
categories those files do not label (suppliers, tax, cash, loan credits).
New statements the classifier is unsure about are stored by app.model and
folded in with partial_fit, so later files keep teaching it.
"""

import csv
import io
import json
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import SGDClassifier
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "kaggle"
MODELS = ROOT / "models"
CAP = 400

LABEL_MAP = {
    "food": "personal",
    "travel": "personal",
    "shopping": "personal",
    "investment": "personal",
    "healthcare": "personal",
    "education": "personal",
    "entertainment": "personal",
    "discretionary": "personal",
    "emi": "emi",
    "utilities": "utilities",
    "salary": "salary",
    "business_income": "business_in",
    "rent": "rent",
    "bounce": "bounce_reversal",
    "window_dressing": "transfer_in",
}

SIDE = {
    "personal": "debit",
    "emi": "debit",
    "utilities": "debit",
    "rent": "debit",
    "supplier": "debit",
    "tax": "debit",
    "cash_out": "debit",
    "self_out": "debit",
    "bounce_charge": "debit",
    "bounce_reversal": "debit",
    "transfer_out": "debit",
    "salary": "credit",
    "business_in": "credit",
    "loan_in": "credit",
    "cash_in": "credit",
    "self_in": "credit",
    "transfer_in": "credit",
}


def clean(text: str) -> str:
    text = re.sub(r"\s*\|\s*Ref:.*", "", text, flags=re.I)
    text = re.sub(r"\s*-\s*INR\s*[\d,.]+\s*-\s*Ref\s*\d+", "", text, flags=re.I)
    text = re.sub(r"\s+INR\s*[\d,.]+\s*TXN[0-9a-fA-F]+", "", text, flags=re.I)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def main() -> None:
    texts, labels = load_labeled_text()
    print(f"narration rows {len(texts)}")
    print("classes", dict(Counter(labels)))
    train_narration(texts, labels)
    train_grade()
    check_phrases()
    from app.train_judgment import main as train_pairs

    train_pairs()


def load_labeled_text() -> tuple[list[str], list[str]]:
    texts: list[str] = []
    labels: list[str] = []
    seen: set[tuple[str, str]] = set()
    counts: Counter[str] = Counter()

    def push(narration: str, category: str, side: str | None = None) -> None:
        narration = clean(narration)
        if not narration or category not in SIDE:
            return
        if counts[category] >= CAP:
            return
        key = (category, narration.lower())
        if key in seen:
            return
        seen.add(key)
        counts[category] += 1
        texts.append(f"{side or SIDE[category]} {narration}")
        labels.append(category)

    for narration, category in gap_rows():
        push(narration, category)
    write_gap_file()

    extracted = DATA / "extracted"
    for path in sorted(extracted.rglob("*.csv")):
        if "msme" in path.parts:
            continue
        with path.open(encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                label = (row.get("Label") or row.get("category") or "").strip()
                narration = row.get("Transaction_Text") or row.get("transaction_text") or ""
                push(narration, LABEL_MAP.get(label.lower(), ""))

    ledger = DATA / "loan-underwriting.zip"
    if ledger.exists():
        with zipfile.ZipFile(ledger) as archive:
            with archive.open("transaction_ledger.csv") as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))
                for row in reader:
                    category = LABEL_MAP.get(row["true_category"], "")
                    push(row["narration_raw"], category, row["direction"])

    return texts, labels


def gap_rows() -> list[tuple[str, str]]:
    mills = [
        "RAJESH MILLS", "SURAT DYE HOUSE", "SHREE YARN", "PACKAGING HOUSE", "BUTTON HOUSE",
        "LONI TEXTILES", "AMAR GREY CLOTH", "KAPAD MILL", "DYEING WORKS", "THREAD HOUSE",
    ]
    buyers = [
        "SHAH WHOLESALE", "PATEL FABRICS", "CITY MART TEXTILES", "MEENA BOUTIQUE", "NOOR GARMENTS",
        "RITA COLLECTIONS", "KAPOOR TRADERS", "DESAI STORES", "MALHOTRA AGENCIES", "JAIN BROTHERS",
    ]
    banks = ["HDFC", "ICICI", "SBI", "AXIS", "KOTAK", "BOB"]
    people = ["RAVI", "MEENA", "OWNER", "PARTNER"]
    rows: list[tuple[str, str]] = []
    for name in mills:
        for tail in ["PURCHASE", "GREY CLOTH", "STOCK", "YARN", "INVOICE PAYMENT"]:
            rows.append((f"NEFT/{name}/{tail}", "supplier"))
            rows.append((f"IMPS/{name}/{tail}", "supplier"))
    for name in buyers:
        for tail in ["INVOICE", "BILL PAYMENT", "SALES RECEIPT"]:
            rows.append((f"NEFT/{name}/{tail}", "business_in"))
            rows.append((f"RTGS/{name}/{tail}", "business_in"))
            rows.append((f"UPI/{name}/OKSBI", "business_in"))
        rows.append((f"CHQ RETURN/{name}/INSUFFICIENT FUNDS", "bounce_reversal"))
    for bank in banks:
        rows.append((f"NACH/{bank} BANK/EMI LOAN", "emi"))
        rows.append((f"ECS-EMI-{bank}-LOAN", "emi"))
        rows.append((f"NEFT/TERM LOAN DISBURSEMENT {bank}", "loan_in"))
        rows.append((f"NEFT/{bank}/LOAN DISBURSEMENT", "loan_in"))
        rows.append((f"CHQ RETURN CHARGES {bank}", "bounce_charge"))
        rows.append((f"ATM CASH WDL {bank}", "cash_out"))
    for kind in ["GST CHALLAN CBDT", "TDS CHALLAN", "INCOME TAX", "GST PAYMENT", "CBDT TAX PAYMENT"]:
        rows.append((kind, "tax"))
        for bank in banks:
            rows.append((f"{kind} {bank}", "tax"))
    for kind in [
        "BESCOM ELECTRICITY BILL", "TORRENT POWER", "JIO BROADBAND", "AIRTEL POSTPAID",
        "WATER BILL", "ELECTRICITY BILL", "BROADBAND BILL",
    ]:
        rows.append((kind, "utilities"))
    for kind in ["ATM CASH WDL", "ATM CASH WDL NFS", "CASH WDL", "NFS CASH WDL"]:
        rows.append((kind, "cash_out"))
    for kind in ["CASH DEPOSIT SELF", "CASH DEPOSIT BRANCH", "BY CASH", "CASH DEP SELF"]:
        rows.append((kind, "cash_in"))
        for bank in banks:
            rows.append((f"{kind} {bank}", "cash_in"))
    for person in people:
        rows.append((f"NEFT/SELF TRF FROM SAVINGS {person}", "self_in"))
        rows.append((f"IMPS/OWN ACCOUNT {person}", "self_in"))
        rows.append((f"NEFT/SELF TRF TO SAVINGS {person}", "self_out"))
        rows.append((f"IMPS/SELF TRANSFER OUT {person}", "self_out"))
        rows.append((f"IMPS/TRANSFER FROM {person}", "transfer_in"))
        rows.append((f"NEFT/TRANSFER TO {person}", "transfer_out"))
    for name in ["LANDLORD SHARMA", "LANDLORD RAO", "HOUSE RENT", "SHOP RENT", "GODOWN RENT"]:
        rows.append((f"NEFT/RENT/{name}", "rent"))
        rows.append((f"UPI/{name}/RENT", "rent"))
    for name in ["SWIGGY", "ZOMATO", "HPCL PETROL", "BIGBASKET", "APOLLO PHARMACY", "NETFLIX", "AMAZON PAY"]:
        rows.append((f"UPI/{name}", "personal"))
    rows.append(("NACH/LIC OF INDIA/INSURANCE", "personal"))
    rows.append(("CHEQUE RETURN CHARGES", "bounce_charge"))
    rows.append(("ECS-RETURN-INSUFFICIENT FUNDS", "bounce_reversal"))
    return rows


def write_gap_file() -> None:
    path = DATA / "supplement" / "gap_narrations.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["narration", "category"])
        writer.writerows(gap_rows())


def train_narration(texts: list[str], labels: list[str]) -> None:
    train_x, test_x, train_y, test_y = train_test_split(
        texts, labels, test_size=0.2, random_state=7, stratify=labels
    )
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), min_df=1, max_features=30000, sublinear_tf=True)
    features = vectorizer.fit_transform(train_x)
    classifier = SGDClassifier(loss="log_loss", alpha=1e-5, class_weight="balanced", random_state=7)
    classifier.fit(features, train_y)
    report = classification_report(test_y, classifier.predict(vectorizer.transform(test_x)), zero_division=0)
    print(report)
    MODELS.mkdir(parents=True, exist_ok=True)
    joblib.dump({"vectorizer": vectorizer, "classifier": classifier, "learned": 0}, MODELS / "narration.joblib")
    (MODELS / "narration_report.txt").write_text(report, encoding="utf-8")


def train_grade() -> None:
    rows = customer_features()
    if len(rows) < 50:
        print("grade model skipped, not enough customers")
        return
    features = ["months", "obligationRatio", "bounces6m", "emiShare", "concentration", "avgEarned"]
    matrix = [[row[name] for name in features] for row in rows]
    target = [grade_of(row) for row in rows]
    print("grade labels", dict(Counter(target)))
    train_x, test_x, train_y, test_y = train_test_split(
        matrix, target, test_size=0.2, random_state=7, stratify=target
    )
    classifier = DecisionTreeClassifier(max_depth=6, random_state=7)
    classifier.fit(train_x, train_y)
    accuracy = classifier.score(test_x, test_y)
    print(f"grade holdout accuracy {accuracy:.3f}")
    joblib.dump({"classifier": classifier, "features": features, "accuracy": accuracy}, MODELS / "grade.joblib")
    (MODELS / "grade_metrics.json").write_text(
        json.dumps({"holdoutAccuracy": round(accuracy, 4), "labels": dict(Counter(target))}, indent=2),
        encoding="utf-8",
    )


def customer_features() -> list[dict]:
    ledger = DATA / "loan-underwriting.zip"
    if not ledger.exists():
        return []
    income = defaultdict(float)
    emi = defaultdict(float)
    rent = defaultdict(float)
    bounces = defaultdict(int)
    months = defaultdict(set)
    business = defaultdict(float)
    buyers = defaultdict(lambda: defaultdict(float))
    with zipfile.ZipFile(ledger) as archive:
        with archive.open("transaction_ledger.csv") as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))
            for row in reader:
                cid = row["customer_id"]
                amount = abs(float(row["amount"]))
                category = row["true_category"]
                months[cid].add(row["date"][:7])
                if category in {"salary", "business_income"} and row["direction"] == "credit":
                    income[cid] += amount
                if category == "business_income" and row["direction"] == "credit":
                    business[cid] += amount
                    buyers[cid][row["narration_raw"].split("-")[0][:40]] += amount
                elif category == "emi":
                    emi[cid] += amount
                elif category == "rent":
                    rent[cid] += amount
                elif category == "bounce":
                    bounces[cid] += 1
    rows = []
    for cid, earned in income.items():
        if earned <= 0:
            continue
        span = max(len(months[cid]), 1)
        top = max(buyers[cid].values()) if buyers[cid] else 0
        rows.append(
            {
                "months": span,
                "obligationRatio": (emi[cid] + rent[cid]) / earned,
                "bounces6m": bounces[cid],
                "emiShare": emi[cid] / earned,
                "concentration": (top / business[cid]) if business[cid] else 0,
                "avgEarned": earned / span,
            }
        )
    return rows


def grade_of(row: dict) -> str:
    ratio = row["obligationRatio"]
    bounces = row["bounces6m"]
    if row["months"] < 6 or row["avgEarned"] < 8000:
        return "E"
    if ratio <= 0.24 and bounces == 0:
        return "A"
    if ratio <= 0.27 and bounces <= 1:
        return "B"
    if ratio <= 0.39 and bounces <= 2:
        return "C"
    if ratio <= 0.6:
        return "D"
    return "E"


def check_phrases() -> None:
    from app.model import predict_category

    samples = [
        ("UPI/SWIGGY", 640, 0, "personal"),
        ("NACH/HDFC BANK/EMI LOAN", 18000, 0, "emi"),
        ("NEFT/RAJESH MILLS/PURCHASE", 50000, 0, "supplier"),
        ("GST CHALLAN CBDT", 15000, 0, "tax"),
        ("NEFT/SHAH WHOLESALE/INVOICE", 0, 90000, "business_in"),
        ("ATM CASH WDL", 4000, 0, "cash_out"),
        ("CHQ RETURN CHARGES", 295, 0, "bounce_charge"),
        ("NEFT/TERM LOAN DISBURSEMENT HDFC", 0, 150000, "loan_in"),
    ]
    for narration, debit, credit, expected in samples:
        guess = predict_category(narration, debit, credit)
        print(expected, guess, narration)


if __name__ == "__main__":
    main()
