import json
from pathlib import Path
from statistics import median

from app.extract import complete
from app.model import predict_grade

LABELS = json.loads((Path(__file__).resolve().parent / "labels.json").read_text(encoding="utf-8"))
GRADES = {item["letter"]: item for item in LABELS["grades"]}


def measure(rows: list[dict]) -> dict:
    months: dict[str, dict] = {}
    for row in rows:
        key = row["date"][:7]
        bucket = months.setdefault(
            key,
            {"earned": 0.0, "emi": 0.0, "rent": 0.0, "ops": 0.0, "charges": 0.0, "bounces": 0},
        )
        category = row["category"]
        if category in {"business_in", "salary"}:
            bucket["earned"] += row["credit"]
            if category == "salary":
                bucket["salary"] = bucket.get("salary", 0.0) + row["credit"]
            else:
                bucket["business"] = bucket.get("business", 0.0) + row["credit"]
        if category == "bounce_reversal":
            bucket["earned"] -= row["debit"]
            if row["debit"] > 0:
                bucket["bounces"] += 1
        if category == "emi":
            bucket["emi"] += row["debit"]
        if category == "rent":
            bucket["rent"] += row["debit"]
        if category in {"supplier", "utilities", "tax"}:
            bucket["ops"] += row["debit"]
        if category == "bounce_charge":
            bucket["charges"] += row["debit"]

    keys = sorted(months)
    cash = [
        months[key]["earned"] - months[key]["emi"] - months[key]["rent"] - months[key]["ops"] - months[key]["charges"]
        for key in keys
    ]
    earned = [months[key]["earned"] for key in keys]
    salary_earned = sum(months[key].get("salary", 0.0) for key in keys)
    business_earned = sum(months[key].get("business", 0.0) for key in keys)
    recent = keys[-6:]
    bounces = sum(months[key]["bounces"] for key in recent)
    avg_earned = sum(earned) / len(earned) if earned else 0
    obligations = sum(months[key]["emi"] + months[key]["rent"] for key in keys) / len(keys) if keys else 0
    buyers: dict[str, float] = {}
    business = 0.0
    for row in rows:
        if row["category"] == "business_in" and row["credit"] > 0:
            business += row["credit"]
            name = row["description"].split("/")[0][:40]
            buyers[name] = buyers.get(name, 0) + row["credit"]
    top_share = (max(buyers.values()) / business) if business and buyers else 0
    total_earned = sum(earned)
    emi_share = (sum(months[key]["emi"] for key in keys) / total_earned) if total_earned else 0
    salary_share = (salary_earned / total_earned) if total_earned else 0
    cash_left = median(cash) if cash else 0
    room = max(0.0, cash_left)
    balances = [float(row.get("balance") or 0) for row in rows if row.get("balance") is not None]
    avg_balance = sum(balances) / len(balances) if balances else 0.0
    cash_in = sum(float(row.get("credit") or 0) for row in rows if row.get("category") == "cash_in")
    total_credits = sum(float(row.get("credit") or 0) for row in rows if float(row.get("credit") or 0) > 0)
    cash_in_share = (cash_in / total_credits) if total_credits else 0.0
    if total_earned <= 0:
        archetype = "mixed"
    elif salary_share >= 0.5:
        archetype = "salary"
    elif (business_earned / total_earned) >= 0.5:
        archetype = "trader"
    else:
        archetype = "mixed"
    return {
        "months": len(keys),
        "cashLeft": round(cash_left, 2),
        "capacityMonthly": round(room * 0.35, 2),
        "bounces6m": bounces,
        "obligationRatio": round(obligations / avg_earned, 4) if avg_earned else 0,
        "emiShare": round(emi_share, 4),
        "concentration": round(top_share, 4),
        "avgEarned": round(avg_earned, 2),
        "salaryShare": round(salary_share, 4),
        "businessEarned": round(business_earned, 2),
        "salaryEarned": round(salary_earned, 2),
        "avgBalance": round(avg_balance, 2),
        "cashInTotal": round(cash_in, 2),
        "cashInShare": round(cash_in_share, 4),
        "archetype": archetype,
        "opaqueCash": cash_in_share >= 0.25,
    }


def choose_grade(metrics: dict) -> dict:
    table = []
    for item in LABELS["grades"]:
        low, high = item["businessRate"]
        table.append(
            f"{item['letter']} {item['label']} points {item['points'][0]}-{item['points'][1]} "
            f"business rate {low:.0%}-{high:.0%}. {item['when']}"
        )
    prompt = (
        "Pick a grade from the table. Return JSON: "
        '{"letter":"A|B|C|D|E","points":0,"label":"","summary":""}. '
        "points must sit inside that letter's range. Do not invent rupee amounts. "
        "summary is two sentences a lender can read.\n\n"
        + "\n".join(table)
        + "\n\nCalculated file:\n"
        + json.dumps(metrics)
    )
    ml_letter = predict_grade(metrics)
    if ml_letter in GRADES:
        prompt += f"\n\nThe trained grade model already chose {ml_letter}. Keep that letter."
    archetype = str(metrics.get("archetype") or "")
    salary_share = float(metrics.get("salaryShare") or 0)
    if archetype == "salary" or salary_share >= 0.5:
        system = (
            "You grade an Indian savings / salary account for an NBFC. "
            "This is a personal salary file, not an MSME current account. "
            "Do not call the borrower an MSME or a business. Stay inside the given bands."
        )
        prompt += (
            "\n\nAccount shape: salary dominates earned inflow. "
            "Write the summary as a salaried individual, not a business."
        )
    elif archetype == "mixed":
        system = (
            "You grade an Indian bank account with mixed salary and other credits for an NBFC. "
            "Stay inside the given bands. Do not invent an MSME story if salary leads."
        )
    else:
        system = "You grade an Indian MSME current-account file. Stay inside the given bands."
    if metrics.get("opaqueCash"):
        prompt += "\n\nCash deposits are a large share of credits; do not treat them as earned strength."
    raw = complete(system, prompt)
    letter = ml_letter if ml_letter in GRADES else str(raw.get("letter") or "C").upper()
    if float(metrics.get("avgEarned") or 0) < 8000 or int(metrics.get("months") or 0) < 6:
        letter = "E"
    elif float(metrics.get("cashLeft") or 0) < 0 and letter in {"A", "B", "C"}:
        letter = "D"
    if letter not in GRADES:
        letter = "C"
    band = GRADES[letter]
    low, high = band["points"]
    try:
        points = int(raw.get("points"))
    except (TypeError, ValueError):
        points = (low + high) // 2
    points = min(high, max(low, points))
    summary = str(raw.get("summary") or "").strip()[:500]
    if letter in {"D", "E"} and any(word in summary.lower() for word in ("strong", "healthy", "solid")):
        summary = (
            "Earned inflow on this statement is thin, and cash left after operations is not positive. "
            "A new facility is not a fit on these terms."
        )
    rates = band["businessRate"]
    return {
        "letter": letter,
        "points": points,
        "label": band["label"],
        "summary": summary,
        "rates": {
            "business": rates,
            "topup": rates,
            "line": [min(rates[0] + 0.02, 0.30), min(rates[1] + 0.02, 0.34)],
            "upi": [min(rates[0] + 0.04, 0.32), min(rates[1] + 0.04, 0.36)],
        },
    }
