import json
import os
import re
import sys
import asyncio
import time
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
category must be one of the allowed labels. Do not invent rows that are not in the text.
A credit from a buyer, invoice, or NEFT/RTGS/IMPS receipt is business_in. Salary is salary.
A loan disbursal is loan_in. A transfer from the same person's other account is self_in. Cash deposit is cash_in.
EMI, NACH loan, or home-loan debit is emi. Rent is rent. Supplier, mill, or stock purchase is supplier.
Electricity, water, phone, and broadband are utilities. GST and income tax are tax.
A returned cheque or reversal of a credit is bounce_reversal. The bank charge for that return is bounce_charge.
ATM withdrawal is cash_out. Food, fuel, shopping, travel, pharmacy, school, SIP, insurance premium, and subscriptions are personal.
"""


CHUNK_SIZE = 16000
WORKERS = 16


def note(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def complete(system: str, user: str) -> dict:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is missing from backend/.env")
    response = None
    for attempt in range(4):
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
            timeout=90,
        )
        if response.status_code != 429 or attempt == 3:
            break
        time.sleep(1.2 * (attempt + 1))
    if response is None:
        raise RuntimeError("The model call failed.")
    if response.status_code in {401, 403}:
        raise RuntimeError("The model key was rejected. Put a live key in backend/.env.")
    if response.status_code >= 400:
        raise RuntimeError(f"The model call failed ({response.status_code}).")
    content = response.json()["choices"][0]["message"]["content"]
    return json.loads(content)


def statement_text(name: str, raw: bytes) -> str:
    if name.lower().endswith(".pdf") or raw[:4] == b"%PDF":
        try:
            reader = PdfReader(BytesIO(raw))
        except Exception as error:
            raise ValueError("This PDF could not be opened. Export a CSV or a text PDF from the bank.") from error
        if reader.is_encrypted and reader.decrypt("") == 0:
            raise ValueError("This statement is password protected. Export a CSV or an unlocked PDF from the bank.")
        pages = []
        blank = []
        for index, page in enumerate(reader.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            if len(text.strip()) < 20:
                blank.append(index)
            pages.append(text)
        if blank and len(blank) == len(pages):
            raise ValueError(
                f"Page {blank[0]} has no text layer. Export a CSV or a text PDF from the bank."
            )
        if blank:
            note(f"skipped {len(blank)} page(s) with no text")
        return "\n".join(pages).strip()
    return raw.decode("utf-8", errors="replace")


MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
MONEY = re.compile(
    r"(?<![\d.])(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}-?"
    r"|(?<![\d.])(?:\d{1,3}(?:,\d{2,3})+|\d+)(?=\s*\(?\s*(?:cr|dr)\b)",
    re.IGNORECASE,
)
DATE_NUMERIC = re.compile(
    r"^(?:(?P<serial>\d{1,5})\s+)?(?P<day>\d{1,2})[./-](?P<month>\d{1,2})[./-](?P<year>\d{2,4})(?P<rest>\s+.*)?$"
)
DATE_NAMED = re.compile(
    r"^(?:(?P<serial>\d{1,5})\s+)?(?P<day>\d{1,2})[\s-](?P<month>[A-Za-z]{3,9})[\s-](?P<year>\d{2,4})(?P<rest>\s+.*)?$"
)
DATE_ISO = re.compile(r"^(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})(?P<rest>\s+.*)?$")
OPENING = re.compile(
    r"opening balance|opening bal|\bop\.?\s*bal\b|balance brought forward|brought forward|brought fwd|balance b/f|\bb/f\b|\bb/fwd\b|previous balance",
    re.IGNORECASE,
)
DATE_RANGE = re.compile(
    r"^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s+(?:to|-|–)\s+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b",
    re.IGNORECASE,
)
LEADING_DATE = re.compile(
    r"^(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}[\s-][A-Za-z]{3,9}[\s-]\d{2,4}|\d{4}-\d{2}-\d{2})\s+",
    re.IGNORECASE,
)
CREDIT_HINTS = (
    "credit trxn", "int.pd", "int paid", "interest paid", "refund", "rfnd", "reversal",
    "by transfer", "neft cr", "imps cr", "upi/cr", "upi cr", "by cash", "cash deposit",
    "by clg", "ach credit", "salary credit", "cr-",
)
DEBIT_HINTS = ("to transfer", "upi/dr", "upi dr", "ach d", "ach dr", "atm-", "pos/", "pos ", "paid via", "withdrawal")
NOISE = (
    "s no.", "s.no", "sl no", "sl.no", "statement of transactions", "your base branch",
    "legends for transactions", "tran date", "transaction date", "txn date", "value date",
)


def parse_statement_rows(text: str) -> list[dict]:
    table = parse_delimited(text)
    if len(table) >= 2:
        return table
    entries = []
    current = None
    opening = None
    for raw_line in text.splitlines():
        line = clean_line(raw_line)
        if not line:
            continue
        opened = opening_amount(line)
        if opened is not None:
            if current is None:
                opening = opened
            continue
        if banner(line):
            continue
        started = match_date_line(line)
        if started:
            boundary = current is None or entry_complete(current)
            if (
                not boundary
                and started["serial"] is not None
                and current["serial"] is not None
                and started["serial"] > current["serial"]
            ):
                boundary = True
            if boundary:
                if current:
                    entries.append(current)
                current = started
            elif started["bits"]:
                current["bits"].extend(started["bits"])
            continue
        if current:
            current["bits"].append(line)
    if current:
        entries.append(current)
    if len(entries) < 2:
        return []

    rows = []
    previous = opening
    for entry in entries:
        parsed = parse_entry(entry, previous)
        if not parsed:
            continue
        previous = parsed["balance"] if parsed["balance"] is not None else previous
        rows.append(parsed)
    rows = align_to_balance(rows, opening)
    if len(rows) < 2 or not chain_holds(rows, opening):
        note("statement layout did not tie to the running balance")
        return []
    if len(rows) < 5 and not fully_tied(rows, opening):
        return []
    return rows


def clean_line(raw: str) -> str:
    line = raw.replace("\u00a0", " ").replace("\u202f", " ").replace("₹", " ")
    line = " ".join(line.split())
    line = re.sub(r"^(\d{1,5})[.)]\s+(?=\d)", r"\1 ", line)
    line = re.sub(r"(\d{1,2})\s*[-/]\s*([A-Za-z]{3,9})\s*[-/]\s*(\d{2,4})", r"\1-\2-\3", line)
    line = re.sub(r"(\d)\s*([./-])\s*(?=\d)", r"\1\2", line)
    return line


def opening_amount(line: str) -> float | None:
    if match_date_line(line) or not OPENING.search(line):
        return None
    amounts = money_matches(line)
    if not amounts:
        return None
    return signed_balance(line, amounts[-1])


def banner(line: str) -> bool:
    lowered = line.lower()
    if DATE_RANGE.match(line) or any(lowered.startswith(prefix) for prefix in NOISE):
        return True
    if re.match(r"^(page\s+\d+|carried forward|c/f\b|grand total|page total)\b", lowered):
        return True
    if "computer generated" in lowered or "end of statement" in lowered or lowered.startswith("registered office"):
        return len(MONEY.findall(line)) < 2
    return False


def entry_complete(entry: dict) -> bool:
    return amount_cluster(" ".join(entry["bits"])) is not None


def parse_entry(entry: dict, previous: float | None) -> dict | None:
    blob = " ".join(entry["bits"])
    cluster = amount_cluster(blob)
    if not cluster:
        return None
    narration = strip_leading_dates(blob[: cluster[0].start()].strip(" |-"))
    if not narration:
        return None
    values = [money_value(item.group()) for item in cluster]
    markers = [amount_marker(blob, item) for item in cluster]
    balance = signed_balance(blob, cluster[-1])
    debit, credit = sides_from_values(narration, values, markers, balance, previous)
    if debit == 0 and credit == 0:
        return None
    return {
        "date": entry["date"],
        "description": narration[:240],
        "debit": round(debit, 2),
        "credit": round(credit, 2),
        "balance": round(balance, 2),
        "category": "other_out" if debit else "other_in",
    }


def strip_leading_dates(text: str) -> str:
    original = text
    for _ in range(2):
        updated = LEADING_DATE.sub("", text).strip()
        if updated == text:
            break
        text = updated
    return text or original


def sides_from_values(narration: str, values: list[float], markers: list[str | None], balance: float, previous: float | None) -> tuple[float, float]:
    if len(values) == 2:
        return side_from_balance(narration, values[0], balance, previous, markers[0])
    withdrawal, deposit = values[0], values[1]
    if withdrawal and deposit and previous is not None:
        delta = round(balance - previous, 2)
        if abs(delta - round(deposit - withdrawal, 2)) <= 0.05:
            return withdrawal, deposit
        if abs(delta - round(withdrawal - deposit, 2)) <= 0.05:
            return deposit, withdrawal
        for amount, marker in ((withdrawal, markers[0]), (deposit, markers[1])):
            if abs(abs(delta) - amount) <= 0.05:
                return side_from_balance(narration, amount, balance, previous, marker)
    if withdrawal and deposit:
        return withdrawal, deposit
    if previous is not None:
        amount = withdrawal or deposit
        marker = markers[0] if withdrawal else markers[1]
        return side_from_balance(narration, amount, balance, previous, marker)
    if withdrawal and not deposit:
        return withdrawal, 0.0
    return 0.0, deposit


def match_date_line(line: str) -> dict | None:
    iso = DATE_ISO.match(line)
    if iso:
        found = build_date(int(iso.group("day")), int(iso.group("month")), int(iso.group("year")))
        if found:
            rest = (iso.group("rest") or "").strip()
            return {"serial": None, "date": found, "bits": [rest] if rest else []}
    for pattern, named in ((DATE_NAMED, True), (DATE_NUMERIC, False)):
        match = pattern.match(line)
        if not match:
            continue
        month_token = match.group("month")
        month = MONTHS.get(month_token.lower()) if named else int(month_token)
        if not month:
            continue
        found = build_date(int(match.group("day")), month, int(match.group("year")))
        if not found:
            continue
        serial = int(match.group("serial")) if match.group("serial") else None
        rest = (match.group("rest") or "").strip()
        return {"serial": serial, "date": found, "bits": [rest] if rest else []}
    return None


def build_date(day: int, month: int, year: int) -> str | None:
    if year < 100:
        year += 2000 if year < 70 else 1900
    if not (1 <= day <= 31 and 1 <= month <= 12 and 1990 <= year <= 2100):
        return None
    return f"{year:04d}-{month:02d}-{day:02d}"


def parse_delimited(text: str) -> list[dict]:
    sample = text[:4000]
    counts = {",": sample.count(","), "\t": sample.count("\t"), "|": sample.count("|"), ";": sample.count(";")}
    delimiter, count = max(counts.items(), key=lambda item: item[1])
    if count < 4:
        return []
    import csv
    from io import StringIO

    rows = list(csv.reader(StringIO(text), delimiter=delimiter))
    header_index = next((index for index, row in enumerate(rows[:20]) if looks_like_header(row)), None)
    if header_index is None:
        return []
    header = [cell.strip().lower() for cell in rows[header_index]]
    columns = {
        "date": find_column(header, ("txn date", "tran date", "transaction date", "posting date", "posted date", "date", "value date", "value dt", "txn dt")),
        "description": find_column(header, ("description", "narration", "particulars", "remarks", "details", "transaction remarks")),
        "debit": find_column(header, ("withdrawal amount", "withdrawal amt", "withdrawal", "debit amount", "debit amt", "debit", "dr")),
        "credit": find_column(header, ("deposit amount", "deposit amt", "deposit", "credit amount", "credit amt", "credit", "cr")),
        "amount": find_column(header, ("transaction amount", "txn amount", "amount")),
        "balance": find_column(header, ("closing balance", "running balance", "available balance", "balance")),
    }
    if columns["date"] < 0 or (columns["debit"] < 0 and columns["credit"] < 0 and columns["amount"] < 0):
        return []
    parsed = []
    opening = None
    for row in rows[header_index + 1 :]:
        if columns["date"] >= len(row):
            continue
        started = match_date_line(clean_line(row[columns["date"]]))
        if not started:
            continue
        description = row[columns["description"]].strip() if 0 <= columns["description"] < len(row) else "Statement row"
        debit, credit = read_side_columns(row, columns)
        balance = cell_balance(row, columns["balance"])
        if debit == 0 and credit == 0:
            if balance is not None and OPENING.search(description):
                opening = balance
            continue
        parsed.append(
            {
                "date": started["date"],
                "description": (description or "Statement row")[:240],
                "debit": debit,
                "credit": credit,
                "balance": balance,
                "category": "other_out" if debit else "other_in",
            }
        )
    parsed = align_to_balance(parsed, opening)
    if len(parsed) < 2 or not chain_holds(parsed, opening):
        return []
    return parsed


def looks_like_header(row: list[str]) -> bool:
    cells = [cell.strip().lower() for cell in row if cell.strip()]
    if len(cells) < 3:
        return False
    has_date = any(cell == name or (len(name) > 2 and cell.startswith(name)) for cell in cells for name in ("date", "txn date", "tran date", "transaction date", "value date", "posted date"))
    has_money = any(any(word in cell for word in ("debit", "credit", "withdrawal", "deposit", "amount")) for cell in cells)
    has_text = any(any(word in cell for word in ("narration", "particulars", "description", "remarks", "details")) for cell in cells)
    return has_date and has_money and has_text


def find_column(header: list[str], names: tuple[str, ...]) -> int:
    for name in names:
        for index, cell in enumerate(header):
            if cell == name or (len(name) > 2 and cell.startswith(name)):
                return index
    return -1


def read_side_columns(row: list[str], columns: dict) -> tuple[float, float]:
    debit_at, credit_at, amount_at = columns["debit"], columns["credit"], columns["amount"]
    if debit_at >= 0 and debit_at == credit_at:
        return marked_sides(cell_at(row, debit_at))
    if debit_at >= 0 and credit_at >= 0:
        return plain_amount(cell_at(row, debit_at)), plain_amount(cell_at(row, credit_at))
    if debit_at >= 0:
        return marked_sides(cell_at(row, debit_at))
    if credit_at >= 0:
        return marked_sides(cell_at(row, credit_at), default="cr")
    if amount_at >= 0:
        return marked_sides(cell_at(row, amount_at))
    return 0.0, 0.0


def cell_at(row: list[str], index: int) -> str:
    if index < 0 or index >= len(row):
        return ""
    return row[index]


def plain_amount(text: str) -> float:
    if not re.search(r"\d", text or ""):
        return 0.0
    cleaned = text.replace(",", "").replace("₹", "").replace("Rs.", "").replace("INR", "")
    cleaned = re.sub(r"\(?\s*(?:cr|dr)\s*\)?", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip().strip("()")
    if cleaned.endswith("-") or cleaned.startswith("-"):
        cleaned = cleaned.strip("-")
    if cleaned in {"", "-", "—"}:
        return 0.0
    try:
        return round(abs(float(cleaned)), 2)
    except ValueError:
        return 0.0


def cell_balance(row: list[str], index: int) -> float | None:
    text = cell_at(row, index).strip()
    if not re.search(r"\d", text):
        return None
    value = plain_amount(text)
    if re.search(r"\bdr\b", text, re.IGNORECASE) or text.endswith("-") or (text.startswith("(") and text.endswith(")")):
        return -value
    return value


def marked_sides(text: str, default: str = "dr") -> tuple[float, float]:
    value = plain_amount(text)
    if value == 0:
        return 0.0, 0.0
    found = re.search(r"\(?\s*(cr|dr)\s*\)?", text, re.IGNORECASE)
    marker = found.group(1).lower() if found else None
    if text.strip().endswith("-") or (text.strip().startswith("(") and text.strip().endswith(")")):
        marker = marker or "dr"
    if marker == "cr" or (marker is None and default == "cr"):
        return 0.0, value
    return value, 0.0


def money_value(text: str) -> float:
    return float(text.replace(",", "").rstrip("-"))


def money_matches(blob: str) -> list[re.Match[str]]:
    found = []
    for match in MONEY.finditer(blob):
        if re.match(r"\.\d{2,4}\b", blob[match.end() : match.end() + 5]):
            continue
        found.append(match)
    return found


def amount_cluster(blob: str) -> list[re.Match[str]] | None:
    matches = money_matches(blob)
    if len(matches) < 2:
        return None
    cluster = [matches[-1]]
    for item in reversed(matches[:-1]):
        if is_amount_gap(blob[item.end() : cluster[0].start()]):
            cluster.insert(0, item)
            if len(cluster) == 3:
                break
        else:
            break
    if len(cluster) < 2:
        return None
    return cluster


def is_amount_gap(between: str) -> bool:
    return re.fullmatch(r"[\s|]*(?:\(?\s*(?:rs\.?|inr|cr|dr)\s*\)?)?[\s|]*", between, flags=re.IGNORECASE) is not None


def amount_marker(blob: str, match: re.Match[str]) -> str | None:
    if match.group().endswith("-"):
        return "dr"
    found = re.match(r"\s*\(?\s*(cr|dr)\b\)?", blob[match.end() : match.end() + 8], re.IGNORECASE)
    if found:
        return found.group(1).lower()
    return None


def signed_balance(blob: str, match: re.Match[str]) -> float:
    value = money_value(match.group())
    if match.group().endswith("-") or amount_marker(blob, match) == "dr":
        return -value
    return value


def side_from_balance(narration: str, amount: float, balance: float, previous: float | None, marker: str | None = None) -> tuple[float, float]:
    if previous is not None:
        delta = round(balance - previous, 2)
        if abs(delta - amount) <= 0.05:
            return 0.0, amount
        if abs(-delta - amount) <= 0.05:
            return amount, 0.0
    if marker == "cr":
        return 0.0, amount
    if marker == "dr":
        return amount, 0.0
    text = narration.lower()
    if any(word in text for word in CREDIT_HINTS):
        return 0.0, amount
    if any(word in text for word in DEBIT_HINTS):
        return amount, 0.0
    return amount, 0.0


def align_to_balance(rows: list[dict], opening: float | None) -> list[dict]:
    previous = opening
    aligned = []
    for row in rows:
        debit, credit, balance = row["debit"], row["credit"], row["balance"]
        amount = round(debit or credit, 2)
        if previous is not None and balance is not None and amount and (debit == 0 or credit == 0):
            delta = round(balance - previous, 2)
            if abs(delta - amount) <= 0.05:
                debit, credit = 0.0, amount
            elif abs(-delta - amount) <= 0.05:
                debit, credit = amount, 0.0
        aligned.append({**row, "debit": debit, "credit": credit, "category": "other_out" if debit else "other_in"})
        if balance is not None:
            previous = balance
    return aligned


def fully_tied(rows: list[dict], opening: float | None) -> bool:
    previous = opening
    checked = 0
    for row in rows:
        balance = row["balance"]
        if balance is None:
            return False
        if previous is not None:
            delta = round(balance - previous, 2)
            moved = round(row["credit"] - row["debit"], 2)
            if abs(delta - moved) > 0.05:
                return False
            checked += 1
        previous = balance
    needed = len(rows) if opening is not None else max(len(rows) - 1, 1)
    return checked >= needed


def chain_holds(rows: list[dict], opening: float | None) -> bool:
    balances = [row["balance"] for row in rows if row["balance"] is not None]
    if len(balances) < 4:
        return True
    previous = opening
    breaks = 0
    checked = 0
    for row in rows:
        balance = row["balance"]
        if previous is not None and balance is not None:
            checked += 1
            delta = round(balance - previous, 2)
            moved = round(row["credit"] - row["debit"], 2)
            if abs(delta - moved) > 0.05:
                breaks += 1
        if balance is not None:
            previous = balance
    if breaks == 0:
        return True
    if checked < 4:
        return False
    return breaks / checked <= 0.08


async def extract_rows(text: str) -> list[dict]:
    local = parse_statement_rows(text)
    if len(local) >= 5:
        note(f"read {len(local)} rows from the statement layout")
        for row in local:
            apply_narration_model(row)
        await classify_open(local)
        return finish_rows(local)
    parts = chunks(text, CHUNK_SIZE)
    workers = min(WORKERS, len(parts)) or 1
    note(f"statement sections {len(parts)} at once")
    limits = httpx.Limits(max_connections=workers, max_keepalive_connections=workers)
    semaphore = asyncio.Semaphore(workers)
    async with httpx.AsyncClient(timeout=90, limits=limits) as client:
        async def one(index: int, part: str) -> list[dict]:
            async with semaphore:
                rows = await read_part(client, part)
                note(f"section {index} rows {len(rows)}")
                return rows

        batches = await asyncio.gather(*(one(index, part) for index, part in enumerate(parts, start=1)))
    rows = []
    seen = set()
    for batch in batches:
        for row in batch:
            apply_narration_model(row)
            key = (row["date"], row["description"], row["debit"], row["credit"])
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
    if not rows:
        raise ValueError("No transactions could be read from this file.")
    await classify_open(rows)
    return finish_rows(rows)


async def read_part(client: httpx.AsyncClient, part: str) -> list[dict]:
    try:
        data = await complete_async(client, SYSTEM, "Statement excerpt:\n" + part)
    except json.JSONDecodeError:
        if len(part) < 2500:
            raise ValueError("A section of the statement came back incomplete. Export a CSV from the bank and send that.") from None
        mid = split_at(part)
        left, right = await asyncio.gather(read_part(client, part[:mid]), read_part(client, part[mid:]))
        return left + right
    rows = []
    for item in data.get("rows") or []:
        row = clean_row(item)
        if row:
            rows.append(row)
    return rows


async def complete_async(client: httpx.AsyncClient, system: str, user: str) -> dict:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is missing from backend/.env")
    response = None
    for attempt in range(4):
        response = await client.post(
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
        )
        if response.status_code != 429 or attempt == 3:
            break
        await asyncio.sleep(1.2 * (attempt + 1))
    if response is None:
        raise RuntimeError("The model call failed.")
    if response.status_code in {401, 403}:
        raise RuntimeError("The model key was rejected. Put a live key in backend/.env.")
    if response.status_code >= 400:
        raise RuntimeError(f"The model call failed ({response.status_code}).")
    content = response.json()["choices"][0]["message"]["content"]
    return json.loads(content)


def split_at(part: str) -> int:
    mid = len(part) // 2
    break_at = part.rfind("\n", 0, mid)
    if break_at > 400:
        return break_at
    return mid


RISKY = {"business_in", "salary", "supplier"}
PERSON_HANDLE = re.compile(r"@(?:ok\w*|ybl|axl|ibl|pty|ptsbi|ptaxis|pthdfc|upi|y)\b", re.I)
MERCHANT_HINTS = re.compile(
    r"swiggy|zomato|zepto|blinkit|dominos|bigbasket|amazon|flipkart|netflix|spotify|youtube|irctc|paytmqr|phonepe|\bcred\b",
    re.I,
)
CLASSIFY_SYSTEM = """You label Indian bank-statement narrations. Return JSON only: {"labels":[{"i":0,"category":"personal"}]}.
Categories: business_in, salary, transfer_in, loan_in, self_in, cash_in, emi, rent, supplier, utilities, tax, bounce_reversal, bounce_charge, cash_out, personal, self_out, transfer_out, other_in, other_out.
Person-to-person UPI, IMPS, or NEFT is transfer_in or transfer_out, never business_in or supplier.
A shop, food app, travel app, subscription, or card spend is personal.
Salary is payroll from an employer. A broker, mutual fund, reimbursement, or investment is other_in or other_out, not salary.
Loan EMI is emi. Electricity, mobile, and broadband are utilities. Stock or mill purchase is supplier.
If the line is unclear, use other_in or other_out. Do not invent a business receipt.
"""


def finish_rows(rows: list[dict]) -> list[dict]:
    for row in rows:
        row.pop("_open", None)
        row.pop("_guess", None)
    rows.sort(key=lambda row: row["date"])
    return rows


def apply_narration_model(row: dict) -> None:
    structural = structural_category(row)
    if structural:
        row["category"] = structural
        return
    guess = predict_category(row["description"], row["debit"], row["credit"])
    if guess is not None:
        category, confidence = guess
        if confidence >= TRUST and category not in RISKY:
            row["category"] = category
            return
        if confidence >= TRUST:
            row["_guess"] = category
    row["_open"] = True


def structural_category(row: dict) -> str | None:
    text = row["description"].lower()
    compact = re.sub(r"\s+", "", text)
    credit = row["credit"]
    debit = row["debit"]
    if "int.pd" in compact or "interestpaid" in compact:
        return "other_in" if credit else "other_out"
    if debit and debit < 5000 and any(token in compact for token in ("chrgs", "chgs", "charges")):
        return "bounce_charge"
    if credit and any(token in text for token in ("by cash", "cash dep", "self cash", "sak/cash dep")):
        return "cash_in"
    if debit and any(token in text for token in ("atm", "cash wdl", "cwdr")):
        return "cash_out"
    if any(token in compact for token in ("refund", "cradj", "ordercan", "cashback", "rfnd")):
        return "other_in" if credit else "other_out"
    if any(token in text for token in ("zerodha", "groww", "upstox", "nse clearing", "bse limited", "mfss")):
        return "other_in" if credit else "other_out"
    if "wise payment" in text:
        return "transfer_in" if credit else "transfer_out"
    if any(token in compact for token in ("upi/p2a", "imps/p2a", "upi/p2p", "imps/p2p")):
        return "transfer_in" if credit else "transfer_out"
    if "imps/" in compact and not any(token in text for token in ("pvt", "ltd", "limited", "mill", "industries", "purchase", "supplier")):
        return "transfer_in" if credit else "transfer_out"
    if credit and re.search(r"\bcred\b", text):
        return "other_in"
    if debit and "upi/p2m" in compact:
        return "personal"
    if debit and MERCHANT_HINTS.search(text):
        return "personal"
    if ("upi/" in text or "upi/" in compact) and PERSON_HANDLE.search(text) and not MERCHANT_HINTS.search(text):
        return "transfer_in" if credit else "transfer_out"
    if debit and ("upi/" in text or "upi/" in compact or "paid via" in text or text.startswith("pos") or text.startswith("ecom")):
        return "personal"
    if credit and "fundtransferinf" in compact:
        return "salary"
    if debit and re.search(r"\bemi\b", text):
        return "emi"
    if debit and re.search(r"\brent\b", text):
        return "rent"
    if debit and any(token in compact for token in ("pymt-card", "pymtcard", "creditcard")):
        return "personal"
    return None


async def classify_open(rows: list[dict]) -> None:
    pending = [row for row in rows if row.get("_open")]
    if not pending:
        return
    grouped: dict[tuple[str, str], list[dict]] = {}
    for row in pending:
        key = ("credit" if row["credit"] else "debit", row["description"].strip().lower()[:180])
        grouped.setdefault(key, []).append(row)
    ranked = sorted(
        grouped.items(),
        key=lambda item: sum(row["credit"] or row["debit"] for row in item[1]),
        reverse=True,
    )[:120]
    items = [
        {"i": index, "side": key[0], "narration": key[1]}
        for index, (key, _) in enumerate(ranked)
    ]
    labelled: dict[int, str] = {}
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            for start in range(0, len(items), 24):
                chunk = items[start:start + 24]
                data = await complete_async(
                    client,
                    CLASSIFY_SYSTEM,
                    "Label each narration:\n" + json.dumps({"rows": chunk}),
                )
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
    except (RuntimeError, ValueError, httpx.HTTPError, KeyError, TypeError) as error:
        note(f"unlabelled rows kept: {error}")
    applied = 0
    for index, (_key, group) in enumerate(ranked):
        category = labelled.get(index) or group[0].get("_guess")
        if not category:
            continue
        for row in group:
            row["category"] = category
        if index in labelled:
            applied += len(group)
    note(f"model labelled {applied} rows the rules left open")


def chunks(text: str, size: int = CHUNK_SIZE) -> list[str]:
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
    value = value.strip()
    named = re.match(r"(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{2,4})", value)
    if named and named.group(2).lower() in MONTHS:
        year = int(named.group(3))
        if year < 100:
            year += 2000 if year < 70 else 1900
        return f"{year:04d}-{MONTHS[named.group(2).lower()]:02d}-{int(named.group(1)):02d}"
    value = value.replace("/", "-")
    parts = value.split("-")
    if len(parts) == 3 and len(parts[0]) == 4:
        return f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
    if len(parts) == 3 and len(parts[2]) == 4:
        return f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
    return ""
