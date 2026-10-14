"""Judge a statement with the party and loop models, then the language model.

The models decide the pairs they were sure about on their holdout. Everything
inside the learned band goes to the language model. Those answers are stored
and folded into the same models, so the next file starts from them.
"""

import json
from collections import defaultdict
from datetime import datetime

import httpx

from app.extract import complete_async
from app.model import learn_from_teacher, learn_loops, learn_parties, predict_loop_many, predict_party_many
from app.names import display_name, share_token

SYSTEM = """You judge one Indian current account for an NBFC. Return JSON only:
{"merges":[{"name":"","aliases":[]}],"splits":[{"a":"","b":""}],"loops":[{"credit_i":[],"debit_i":[],"detail":""}],"obligations":[{"i":[],"detail":"","late":false}],"investing":[{"i":[],"detail":""}],"binding_month":null,"binding_detail":"","changes":[{"title":"","detail":"","severity":"watch","i":[]}]}
Use only indexes, names, and month keys from the brief.
merges are open name pairs that are one real party. splits undo a confirmed merge that is wrong.
A loop is the same rupee coming back. A supplier paid and a different buyer paying is not a loop.
An obligation is a repeating debit that is already debt, including ones that were not labelled EMI.
Investing is a one-off asset purchase, not stock bought to resell.
binding_month is the month that should size a new facility, or null to keep a typical month.
changes are shifts against this account's own earlier months.
If declared sales or a declared EMI were provided, add one change that states the gap.
Do not apply a fixed percentage, a fixed rupee amount, or a fixed number of days. Judge this account.
severity is good, info, watch, or breach.
"""


async def judge(rows: list[dict], declared_sales: float | None = None, declared_emi: float | None = None) -> dict:
    prepared = prepare(rows)
    brief = build_brief(prepared, declared_sales, declared_emi)
    decision = None
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            decision = await complete_async(client, SYSTEM, json.dumps(brief))
    except (RuntimeError, ValueError, httpx.HTTPError, KeyError, TypeError, json.JSONDecodeError):
        decision = None
    if isinstance(decision, dict):
        learn(prepared, decision)
    return shape(prepared, decision if isinstance(decision, dict) else {})


def prepare(rows: list[dict]) -> dict:
    named = []
    for index, row in enumerate(rows):
        named.append({**row, "i": index, "name": display_name(str(row.get("description") or ""))})
    names = list(dict.fromkeys(item["name"] for item in named if item["name"]))
    pairs = [(a, b) for i, a in enumerate(names) for b in names[i + 1:] if share_token(a, b)]
    party = predict_party_many(pairs)
    parent = {name: name for name in names}

    def find(name: str) -> str:
        while parent[name] != name:
            parent[name] = parent[parent[name]]
            name = parent[name]
        return name

    open_pairs = []
    open_names = []
    for (a, b), label in zip(pairs, party):
        if label == "same":
            parent[find(a)] = find(b)
        elif label == "open":
            open_pairs.append({"a": a, "b": b})
            open_names.append((a, b))
    clusters: dict[str, list[str]] = defaultdict(list)
    for name in names:
        root = find(name)
        if name not in clusters[root]:
            clusters[root].append(name)
    groups = []
    for aliases in clusters.values():
        canonical = max(aliases, key=len)
        members = [item for item in named if item["name"] in aliases]
        groups.append({"name": canonical, "aliases": aliases, "rows": members})

    loop_pairs = []
    for group in groups:
        credits = [item for item in group["rows"] if float(item.get("credit") or 0) > 0]
        debits = [item for item in group["rows"] if float(item.get("debit") or 0) > 0]
        for credit in credits:
            for debit in debits:
                loop_pairs.append((credit, debit))
    loop_labels = predict_loop_many(
        [(item[0]["description"], item[1]["description"]) for item in loop_pairs]
    )
    by_name: dict[str, list[dict]] = defaultdict(list)
    for item in named:
        if item["name"]:
            by_name[item["name"]].append(item)
    for a, b in open_names:
        credits = [item for item in by_name[a] + by_name[b] if float(item.get("credit") or 0) > 0]
        debits = [item for item in by_name[a] + by_name[b] if float(item.get("debit") or 0) > 0]
        for credit in credits:
            for debit in debits:
                if credit["name"] == debit["name"]:
                    continue
                loop_pairs.append((credit, debit))
    if len(loop_labels) < len(loop_pairs):
        loop_labels.extend(
            predict_loop_many(
                [(item[0]["description"], item[1]["description"]) for item in loop_pairs[len(loop_labels):]]
            )
        )
    proposed_loops = []
    open_loops = []
    for (credit, debit), label in zip(loop_pairs, loop_labels):
        slot = {"credit_i": credit["i"], "debit_i": debit["i"], "model": label}
        if label == "loop":
            proposed_loops.append(slot)
        elif label == "open":
            open_loops.append(slot)
    open_loops.sort(key=lambda item: abs(float(named[item["credit_i"]].get("credit") or 0) - float(named[item["debit_i"]].get("debit") or 0)))
    return {
        "rows": named,
        "groups": groups,
        "open_pairs": open_pairs[:40],
        "proposed_loops": proposed_loops[:30],
        "open_loops": open_loops[:24],
        "pair_labels": {(a, b): label for (a, b), label in zip(pairs, party)},
    }


def build_brief(prepared: dict, declared_sales: float | None, declared_emi: float | None) -> dict:
    rows = prepared["rows"]
    by_name: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if row.get("name"):
            by_name[row["name"]].append(row)
    months: dict[str, dict] = {}
    for row in rows:
        key = str(row.get("date") or "")[:7]
        if len(key) < 7:
            continue
        bucket = months.setdefault(key, {"earned": 0.0, "suppliers": 0.0, "emi": 0.0, "cashIn": 0.0, "credits": 0.0})
        category = row.get("category")
        credit = float(row.get("credit") or 0)
        debit = float(row.get("debit") or 0)
        bucket["credits"] += credit
        if category in {"business_in", "salary"}:
            bucket["earned"] += credit
        if category == "supplier":
            bucket["suppliers"] += debit
        if category == "emi":
            bucket["emi"] += debit
        if category == "cash_in":
            bucket["cashIn"] += credit
    repeats: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if float(row.get("debit") or 0) <= 0 or not row["name"]:
            continue
        if row.get("category") in {"emi", "rent", "utilities", "tax", "bounce_charge", "bounce_reversal"}:
            continue
        repeats[row["name"]].append(row)
    series = []
    for name, items in repeats.items():
        month_keys = {str(item.get("date") or "")[:7] for item in items}
        if len(month_keys) < 2:
            continue
        series.append(
            {
                "name": name,
                "category": items[0].get("category"),
                "months": sorted(month_keys),
                "rows": [{"i": item["i"], "date": item.get("date"), "amount": item.get("debit")} for item in items[:18]],
            }
        )
    both = []
    for group in prepared["groups"]:
        credits = [item for item in group["rows"] if float(item.get("credit") or 0) > 0]
        debits = [item for item in group["rows"] if float(item.get("debit") or 0) > 0]
        if not credits or not debits:
            continue
        both.append(
            {
                "name": group["name"],
                "credits": [_line(item) for item in credits[:12]],
                "debits": [_line(item) for item in debits[:12]],
            }
        )
    present = sorted(months)
    missing = missing_months(present)
    brief = {
        "confirmed_parties": [
            {"name": group["name"], "aliases": group["aliases"]}
            for group in prepared["groups"]
            if len(group["aliases"]) > 1
        ],
        "open_name_pairs": [
            {
                **pair,
                "a_rows": [_line(item) for item in by_name.get(pair["a"], [])[:6]],
                "b_rows": [_line(item) for item in by_name.get(pair["b"], [])[:6]],
            }
            for pair in prepared["open_pairs"]
        ],
        "both_sides": both[:12],
        "model_loops": [_pair_brief(item) for item in prepared["proposed_loops"]],
        "open_loops": [_pair_brief(item) for item in prepared["open_loops"]],
        "repeating_debits": series[:20],
        "months": [{"month": key, **{field: round(value, 2) for field, value in bucket.items()}} for key, bucket in sorted(months.items())],
        "missing_months": missing,
    }
    if declared_sales is not None or declared_emi is not None:
        earned = [bucket["earned"] for bucket in months.values()]
        brief["declared"] = {
            "sales": declared_sales,
            "emi": declared_emi,
            "average_earned": round(sum(earned) / len(earned), 2) if earned else 0,
        }
    return brief


def shape(prepared: dict, decision: dict) -> dict:
    rows = prepared["rows"]
    parent = {}
    aliases_of: dict[str, set[str]] = {}
    for group in prepared["groups"]:
        for alias in group["aliases"]:
            parent[alias] = group["name"]
            aliases_of.setdefault(group["name"], set()).update(group["aliases"])

    def find(name: str) -> str:
        seen = set()
        while name in parent and parent[name] != name and name not in seen:
            seen.add(name)
            name = parent[name]
        return name

    for item in decision.get("merges") or []:
        if not isinstance(item, dict):
            continue
        aliases = [str(alias) for alias in item.get("aliases") or [] if str(alias).strip()]
        canonical = str(item.get("name") or (aliases[0] if aliases else "")).strip()
        if not canonical:
            continue
        for alias in aliases:
            parent[alias] = canonical
            aliases_of.setdefault(canonical, set()).add(alias)
            aliases_of.setdefault(canonical, set()).add(canonical)
    for item in decision.get("splits") or []:
        if not isinstance(item, dict):
            continue
        for key in ("a", "b"):
            name = str(item.get(key) or "").strip()
            if name:
                parent[name] = name

    parties = []
    seen_party = set()
    for group in prepared["groups"]:
        canonical = find(group["name"])
        if canonical in seen_party:
            continue
        seen_party.add(canonical)
        keys = [row["key"] for row in rows if row["name"] and find(row["name"]) == canonical and row.get("key")]
        alias_list = sorted(aliases_of.get(canonical) or aliases_of.get(group["name"]) or {canonical})
        if keys:
            parties.append({"name": canonical, "aliases": alias_list, "keys": keys})

    model_loops = _pairs(None, prepared["proposed_loops"])
    extra_loops = _pairs(decision.get("loops"), []) if decision and "loops" in decision else []
    seen_loops = set()
    loop_ids = []
    for credits, debits, detail in model_loops + extra_loops:
        key = (tuple(credits), tuple(debits))
        if key in seen_loops:
            continue
        seen_loops.add(key)
        loop_ids.append((credits, debits, detail))
    aside = []
    notes = []
    for index, (credits, debits, detail) in enumerate(loop_ids):
        credit_keys = [_key(rows, i) for i in credits]
        debit_keys = [_key(rows, i) for i in debits]
        amount = sum(float(rows[i].get("credit") or 0) for i in credits if 0 <= i < len(rows))
        aside.extend(key for key in credit_keys if key)
        notes.append(
            {
                "code": f"judge-loop-{index}",
                "title": "The same rupee comes back",
                "detail": _sentence(detail, f"{_rupees(amount)} leaves earned inflow."),
                "severity": "watch",
                "keys": [key for key in credit_keys + debit_keys if key],
            }
        )

    for index, item in enumerate(decision.get("obligations") or []):
        if not isinstance(item, dict):
            continue
        keys = [_key(rows, i) for i in _ints(item.get("i"))]
        keys = [key for key in keys if key]
        if not keys:
            continue
        notes.append(
            {
                "code": f"judge-debt-{index}",
                "title": "A repeating debit is already debt",
                "detail": _sentence(item.get("detail"), "These rows are counted with the obligations."),
                "severity": "watch" if item.get("late") else "info",
                "keys": keys,
            }
        )

    for index, item in enumerate(decision.get("investing") or []):
        if not isinstance(item, dict):
            continue
        keys = [key for key in (_key(rows, i) for i in _ints(item.get("i"))) if key]
        if not keys:
            continue
        notes.append(
            {
                "code": f"judge-asset-{index}",
                "title": "A one-off purchase is not an operating cost",
                "detail": _sentence(item.get("detail"), "It is left out of the month it fell in."),
                "severity": "info",
                "keys": keys,
            }
        )

    binding = str(decision.get("binding_month") or "")
    month_keys = {str(row.get("date") or "")[:7] for row in rows}
    if binding not in month_keys:
        binding = ""
    if binding:
        notes.append(
            {
                "code": "judge-bind",
                "title": f"{binding} sizes the facility",
                "detail": _sentence(decision.get("binding_detail"), "The facility uses this month instead of a typical one."),
                "severity": "info",
                "keys": [row["key"] for row in rows if str(row.get("date") or "").startswith(binding) and row.get("key")],
            }
        )

    for index, item in enumerate(decision.get("changes") or []):
        if not isinstance(item, dict) or not str(item.get("title") or "").strip():
            continue
        severity = str(item.get("severity") or "info")
        if severity not in {"good", "info", "watch", "breach"}:
            severity = "info"
        notes.append(
            {
                "code": f"judge-change-{index}",
                "title": str(item.get("title")).strip()[:120],
                "detail": str(item.get("detail") or "").strip()[:500],
                "severity": severity,
                "keys": [key for key in (_key(rows, i) for i in _ints(item.get("i"))) if key],
            }
        )

    for index, party in enumerate(parties):
        aliases = [alias for alias in party["aliases"] if alias and alias != party["name"]]
        if not aliases:
            continue
        notes.append(
            {
                "code": f"judge-party-{index}",
                "title": f"{party['name']} is one payer",
                "detail": "The statement spells this party as " + ", ".join([party["name"], *aliases]) + ".",
                "severity": "info",
                "keys": party["keys"],
            }
        )

    obligation_keys = []
    for item in decision.get("obligations") or []:
        if isinstance(item, dict):
            obligation_keys.extend(key for key in (_key(rows, i) for i in _ints(item.get("i"))) if key)
    investing_keys = []
    for item in decision.get("investing") or []:
        if isinstance(item, dict):
            investing_keys.extend(key for key in (_key(rows, i) for i in _ints(item.get("i"))) if key)

    return {
        "parties": parties,
        "asideKeys": aside,
        "obligationKeys": obligation_keys,
        "investingKeys": investing_keys,
        "bindingMonth": binding or None,
        "missingMonths": missing_months(sorted({str(row.get("date") or "")[:7] for row in rows if len(str(row.get("date") or "")) >= 7})),
        "notes": notes,
    }


def learn(prepared: dict, decision: dict) -> None:
    party_rows = []
    merged = set()
    for item in decision.get("merges") or []:
        if not isinstance(item, dict):
            continue
        aliases = [str(alias).strip() for alias in item.get("aliases") or [] if str(alias).strip()]
        for index, left in enumerate(aliases):
            for right in aliases[index + 1:]:
                merged.add(tuple(sorted((left.lower(), right.lower()))))
                if prepared["pair_labels"].get((left, right), prepared["pair_labels"].get((right, left))) != "same":
                    party_rows.append((left, right, "same"))
    for pair in prepared["open_pairs"]:
        key = tuple(sorted((pair["a"].lower(), pair["b"].lower())))
        if key not in merged:
            party_rows.append((pair["a"], pair["b"], "different"))
    learn_parties(party_rows)

    loop_rows = []
    rows = prepared["rows"]
    for credits, debits, _detail in _pairs(decision.get("loops"), []):
        for credit_i in credits:
            for debit_i in debits:
                if 0 <= credit_i < len(rows) and 0 <= debit_i < len(rows):
                    loop_rows.append((str(rows[credit_i].get("description") or ""), str(rows[debit_i].get("description") or ""), "loop"))
    kept = {(item["credit_i"], item["debit_i"]) for item in prepared["open_loops"]}
    accepted = set()
    for credits, debits, _detail in _pairs(decision.get("loops"), []):
        for credit_i in credits:
            for debit_i in debits:
                accepted.add((credit_i, debit_i))
    for item in prepared["open_loops"]:
        pair = (item["credit_i"], item["debit_i"])
        if pair in kept and pair not in accepted:
            credit = rows[item["credit_i"]]
            debit = rows[item["debit_i"]]
            loop_rows.append((str(credit.get("description") or ""), str(debit.get("description") or ""), "keep"))
    learn_loops(loop_rows)

    for item in decision.get("obligations") or []:
        if not isinstance(item, dict):
            continue
        for index in _ints(item.get("i")):
            if 0 <= index < len(rows):
                row = rows[index]
                learn_from_teacher(str(row.get("description") or ""), "emi", float(row.get("debit") or 0), float(row.get("credit") or 0), 0.0)


def _pairs(items, fallback: list[dict]) -> list[tuple[list[int], list[int], str]]:
    source = items if isinstance(items, list) else None
    if source is None:
        source = fallback
    parsed = []
    for item in source or []:
        if not isinstance(item, dict):
            continue
        credits = _ints(item.get("credit_i"))
        debits = _ints(item.get("debit_i"))
        if credits and debits:
            parsed.append((credits, debits, str(item.get("detail") or "")))
    if not parsed and fallback and source is not fallback:
        return _pairs(fallback, [])
    return parsed


def _pair_brief(item: dict) -> dict:
    return {"credit_i": [item["credit_i"]], "debit_i": [item["debit_i"]], "model": item.get("model")}


def _ints(value) -> list[int]:
    if isinstance(value, int) and not isinstance(value, bool):
        return [value]
    if not isinstance(value, list):
        return []
    found = []
    for item in value:
        try:
            found.append(int(item))
        except (TypeError, ValueError):
            continue
    return found


def _key(rows: list[dict], index: int) -> str:
    if index < 0 or index >= len(rows):
        return ""
    return str(rows[index].get("key") or "")


def _line(row: dict) -> dict:
    return {
        "i": row["i"],
        "date": row.get("date"),
        "narration": str(row.get("description") or "")[:80],
        "amount": row.get("credit") or row.get("debit"),
        "side": "in" if float(row.get("credit") or 0) > 0 else "out",
    }


def _sentence(primary, extra: str) -> str:
    text = str(primary or "").strip()
    if not text:
        return extra
    if extra.lower() in text.lower():
        return text[:500]
    return f"{text} {extra}"[:500]


def _rupees(value: float) -> str:
    return f"₹{value:,.0f}"


def missing_months(keys: list[str]) -> list[str]:
    parsed = []
    for key in keys:
        try:
            parsed.append(datetime.strptime(key, "%Y-%m"))
        except ValueError:
            continue
    if len(parsed) < 2:
        return []
    found = {item.strftime("%Y-%m") for item in parsed}
    cursor = parsed[0]
    last = parsed[-1]
    missing = []
    while cursor < last:
        year = cursor.year + (1 if cursor.month == 12 else 0)
        month = 1 if cursor.month == 12 else cursor.month + 1
        cursor = cursor.replace(year=year, month=month)
        key = cursor.strftime("%Y-%m")
        if key not in found and cursor < last:
            missing.append(key)
        if cursor >= last:
            break
    return missing
