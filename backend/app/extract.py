import json
import os
from io import BytesIO
from pathlib import Path

import httpx
from pypdf import PdfReader

from app.model import TRUST, learn_from_teacher, predict_category

ROOT = Path(__file__).resolve().parent
LABELS = json.loads((ROOT / "labels.json").read_text(encoding="utf-8"))
MODEL = "openai/gpt-4o-mini"
CATEGORIES = set(LABELS["categories"])

SYSTEM = """You extract Indian bank-statement rows. Return JSON only: {"rows":[...]}.
Each row has date (YYYY-MM-DD), narration, debit, credit, balance, category.
debit and credit are numbers. One side is 0. balance is a number or null.
category must be one of the allowed labels. Use the examples. Do not invent rows that are not in the text.
A credit from a buyer, invoice, or NEFT/RTGS/IMPS receipt is business_in. Salary is salary.
A loan disbursal is loan_in. A transfer from the same person's other account is self_in. Cash deposit is cash_in.
EMI, NACH loan, or home-loan debit is emi. Rent is rent. Supplier, mill, or stock purchase is supplier.
Electricity, water, phone, and broadband are utilities. GST and income tax are tax.
A returned cheque or reversal of a credit is bounce_reversal. The bank charge for that return is bounce_charge.
ATM withdrawal is cash_out. Food, fuel, shopping, travel, pharmacy, school, SIP, insurance premium, and subscriptions are personal.
"""


def labels_block() -> str:
    lines = ["Allowed categories: " + ", ".join(LABELS["categories"])]
    lines.append("Examples:")
    for item in LABELS["examples"]:
        lines.append(f"- {item['narration']} -> {item['category']}")
    return "\n".join(lines)


def complete(system: str, user: str) -> dict:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is missing from backend/.env")
    response = httpx.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": MODEL,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        },
        timeout=120,
    )
    if response.status_code in {401, 403}:
        raise RuntimeError("The model key was rejected. Put a live key in backend/.env.")
    if response.status_code >= 400:
        raise RuntimeError(f"The model call failed ({response.status_code}).")
    content = response.json()["choices"][0]["message"]["content"]
    return json.loads(content)


def statement_text(name: str, raw: bytes) -> str:
    if name.lower().endswith(".pdf") or raw[:4] == b"%PDF":
        reader = PdfReader(BytesIO(raw))
        pages = []
        blank = []
        for index, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ""
            if len(text.strip()) < 20:
                blank.append(index)
            pages.append(text)
        if blank:
            page = blank[0]
            raise ValueError(
                f"Page {page} has no text layer. Export a CSV or a text PDF from the bank."
            )
        return "\n".join(pages).strip()
    return raw.decode("utf-8", errors="replace")


def extract_rows(text: str) -> list[dict]:
    rows = []
    seen = set()
    for part in chunks(text):
        data = complete(
            SYSTEM,
            labels_block() + "\n\nStatement:\n" + part,
        )
        for item in data.get("rows") or []:
            row = clean_row(item)
            if not row:
                continue
            apply_narration_model(row)
            key = (row["date"], row["description"], row["debit"], row["credit"])
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
    if not rows:
        raise ValueError("No transactions could be read from this file.")
    rows.sort(key=lambda row: row["date"])
    return rows


def apply_narration_model(row: dict) -> None:
    guess = predict_category(row["description"], row["debit"], row["credit"])
    if guess is None:
        return
    category, confidence = guess
    if confidence >= TRUST:
        row["category"] = category
        return
    learn_from_teacher(row["description"], row["category"], row["debit"], row["credit"], confidence)


def chunks(text: str, size: int = 60000) -> list[str]:
    if len(text) <= size:
        return [text]
    parts = []
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text):
            break_at = text.rfind("\n", start, end)
            if break_at > start + 1000:
                end = break_at
        parts.append(text[start:end])
        start = end
    return parts


def clean_row(item: dict) -> dict | None:
    if not isinstance(item, dict):
        return None
    date = normalize_date(str(item.get("date") or ""))
    narration = str(item.get("narration") or item.get("description") or "").strip()
    if not date or not narration:
        return None
    category = str(item.get("category") or "other_out")
    if category not in CATEGORIES:
        category = "other_out" if money(item.get("debit")) else "other_in"
    debit = money(item.get("debit"))
    credit = money(item.get("credit"))
    if debit == 0 and credit == 0:
        return None
    balance = item.get("balance")
    return {
        "date": date,
        "description": narration[:240],
        "debit": debit,
        "credit": credit,
        "balance": money(balance) if balance not in (None, "") else None,
        "category": category,
    }


def money(value) -> float:
    if value is None:
        return 0.0
    text = str(value).replace(",", "").replace("₹", "").replace("Rs.", "").replace("INR", "").strip()
    if text in {"", "-", "—"}:
        return 0.0
    try:
        return round(abs(float(text)), 2)
    except ValueError:
        return 0.0


def normalize_date(value: str) -> str:
    value = value.strip().replace("/", "-")
    parts = value.split("-")
    if len(parts) == 3 and len(parts[0]) == 4:
        return f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
    if len(parts) == 3 and len(parts[2]) == 4:
        return f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
    return ""
