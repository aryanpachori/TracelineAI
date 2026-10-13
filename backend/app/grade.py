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
    emi_share = (sum(months[key]["emi"] for key in keys) / sum(earned)) if sum(earned) else 0
    cash_left = median(cash) if cash else 0
    room = max(0.0, cash_left)
    return {
        "months": len(keys),
        "cashLeft": round(cash_left, 2),
        "capacityMonthly": round(room * 0.35, 2),
        "bounces6m": bounces,
        "obligationRatio": round(obligations / avg_earned, 4) if avg_earned else 0,
        "emiShare": round(emi_share, 4),
        "concentration": round(top_share, 4),
        "avgEarned": round(avg_earned, 2),
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
    raw = complete("You grade an Indian MSME current-account file. Stay inside the given bands.", prompt)
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
