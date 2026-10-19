"""Judge a statement with the party and loop models, then the language model.

The models decide the pairs they were sure about on their holdout. Everything
inside the learned band goes to the language model. Those answers are stored
and folded into the same models, so the next file starts from them.
"""

import json
import re
from collections import defaultdict
from datetime import datetime

import httpx

from app.extract import complete_async
from app.model import learn_from_teacher, learn_loops, learn_parties, predict_loop_many, predict_party_many
from app.names import display_name, share_token

SYSTEM = """You judge one Indian bank account for an NBFC. Return JSON only:
{"merges":[{"name":"","aliases":[]}],"splits":[{"a":"","b":""}],"loops":[{"credit_i":[],"debit_i":[],"detail":""}],"obligations":[{"i":[],"kind":"debt|self|people","detail":"","late":false}],"cash_chains":[{"cash_i":[],"out_i":[],"detail":""}],"investing":[{"i":[],"detail":""}],"archetype":"salary|trader|mixed","binding_month":null,"binding_detail":"","changes":[{"title":"","detail":"","severity":"watch","i":[]}],"conduct":{"spender":"","consistency":"steady","risk":"watch","line":""}}
Use only indexes, names, and month keys from the brief. Prefer the structural candidates in the brief over inventing new ones.
merges are open name pairs that are one real party. splits undo a confirmed merge that is wrong.
A loop is the same rupee coming back. Drop refunds, card reversals, and tiny noise. A supplier paid and a different buyer paying is not a loop.
obligations.kind is debt (EMI, card, NACH, lender), self (own-account hop), or people (person UPI/transfer). Never call self or people debt.
cash_chains are cash deposits that leave soon as self or transfer out — opaque source, not earned income.
archetype must be salary, trader, or mixed; start from structural.archetype in the brief.
binding_month should size a new facility after stripping cash deposits and self-out; prefer structural.binding_hint when it fits.
Investing is a one-off asset purchase, not stock bought to resell.
changes are shifts against this account's own earlier months.
If declared sales or a declared EMI were provided, add one change that states the gap.
conduct names the spender, whether months agree, and risk of a new EMI.
consistency is steady, uneven, or inconsistent. risk is contained, watch, or high.
line must say eligible, not eligible, or eligible with watch, plus the single strongest reason, in one sentence an officer can read in a few seconds.
Do not apply a fixed percentage, a fixed rupee amount, or a fixed number of days. Judge this account.
severity is good, info, watch, or breach.
"""

DEBT_HINT = re.compile(
    r"\bemi\b|nach|ecs|cred\.?club|\bcred\b|credit\s*card|bajaj|bfl|kreditbee|\bnavi\b|"
    r"slice|lazypay|simpl|home\s*credit|moneyview|earlysalary|postpe|snapmint|"
    r"loan\s*(emi|repay|instal)|emi\s*loan",
    re.I,
)
LOOP_NOISE = re.compile(r"refund|cradj|ordercan|cashback|\brfnd\b|paymnt\s*rvsl|payment\s*rvsl|reversal", re.I)


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
        if _noisy_loop(credit, debit):
            continue
        amount = float(credit.get("credit") or 0)
        if amount < 500:
            continue
        slot = {"credit_i": credit["i"], "debit_i": debit["i"], "model": label, "amount": amount}
        if label == "loop":
            proposed_loops.append(slot)
        elif label == "open":
            open_loops.append(slot)
    proposed_loops.sort(key=lambda item: float(item.get("amount") or 0), reverse=True)
    open_loops.sort(key=lambda item: abs(float(named[item["credit_i"]].get("credit") or 0) - float(named[item["debit_i"]].get("debit") or 0)))
    structural = structural_intel(named)
    return {
        "rows": named,
        "groups": groups,
        "open_pairs": open_pairs[:40],
        "proposed_loops": proposed_loops[:12],
        "open_loops": open_loops[:16],
        "pair_labels": {(a, b): label for (a, b), label in zip(pairs, party)},
        "structural": structural,
    }


def _noisy_loop(credit: dict, debit: dict) -> bool:
    text = f"{credit.get('description') or ''} {debit.get('description') or ''}"
    return bool(LOOP_NOISE.search(text))


def structural_intel(rows: list[dict]) -> dict:
    salary = sum(float(row.get("credit") or 0) for row in rows if row.get("category") == "salary")
    business = sum(float(row.get("credit") or 0) for row in rows if row.get("category") == "business_in")
    earned = salary + business
    cash_in_total = sum(float(row.get("credit") or 0) for row in rows if row.get("category") == "cash_in")
    total_credits = sum(float(row.get("credit") or 0) for row in rows if float(row.get("credit") or 0) > 0)
    if earned <= 0:
        archetype = "mixed"
    elif salary / earned >= 0.5:
        archetype = "salary"
    elif business / earned >= 0.5:
        archetype = "trader"
    else:
        archetype = "mixed"
    cash_share = (cash_in_total / total_credits) if total_credits else 0.0
    return {
        "archetype": archetype,
        "salaryShare": round(salary / earned, 4) if earned else 0.0,
        "cashInShare": round(cash_share, 4),
        "cash_chains": _cash_chains(rows),
        "obligation_candidates": _obligation_candidates(rows),
        "binding_hint": _binding_hint(rows),
        "opaqueCash": cash_share >= 0.25,
    }


def _parse_date(value: str) -> datetime | None:
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d")
    except ValueError:
        return None


def _cash_chains(rows: list[dict]) -> list[dict]:
    cash_rows = [row for row in rows if row.get("category") == "cash_in" and float(row.get("credit") or 0) >= 5000]
    out_rows = [
        row
        for row in rows
        if float(row.get("debit") or 0) >= 5000
        and row.get("category") in {"self_out", "transfer_out"}
    ]
    chains = []
    used_out = set()
    for cash in cash_rows:
        start = _parse_date(str(cash.get("date") or ""))
        if not start:
            continue
        amount = float(cash.get("credit") or 0)
        best = None
        best_days = 99
        for out in out_rows:
            if out["i"] in used_out:
                continue
            end = _parse_date(str(out.get("date") or ""))
            if not end:
                continue
            days = (end - start).days
            if days < 0 or days > 3:
                continue
            debit = float(out.get("debit") or 0)
            if abs(debit - amount) > max(80.0, amount * 0.02):
                continue
            if days < best_days:
                best = out
                best_days = days
        if best is None:
            # Same-day / near-day sweep of similar large out without exact match.
            for out in out_rows:
                if out["i"] in used_out:
                    continue
                end = _parse_date(str(out.get("date") or ""))
                if not end:
                    continue
                days = (end - start).days
                if days < 0 or days > 3:
                    continue
                debit = float(out.get("debit") or 0)
                if debit < amount * 0.7:
                    continue
                best = out
                best_days = days
                break
        if best is None:
            continue
        used_out.add(best["i"])
        chains.append(
            {
                "cash_i": [cash["i"]],
                "out_i": [best["i"]],
                "amount": round(amount, 2),
                "days": best_days,
                "detail": f"Cash in leaves as {best.get('category')} within {best_days} day(s).",
            }
        )
    chains.sort(key=lambda item: float(item.get("amount") or 0), reverse=True)
    return chains[:12]


def _obligation_candidates(rows: list[dict]) -> list[dict]:
    by_name: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if float(row.get("debit") or 0) <= 0 or not row.get("name"):
            continue
        if row.get("category") in {"bounce_charge", "bounce_reversal", "other_out"}:
            continue
        by_name[row["name"]].append(row)
    candidates = []
    for name, items in by_name.items():
        months = {str(item.get("date") or "")[:7] for item in items}
        if len(months) < 2:
            continue
        text = " ".join(str(item.get("description") or "") for item in items[:6])
        category = items[0].get("category")
        if category == "self_out" or all(item.get("category") == "self_out" for item in items):
            kind = "self"
        elif DEBT_HINT.search(text) or category in {"emi", "rent"}:
            kind = "debt"
        elif category in {"transfer_out"} or ("upi" in text.lower() and "@" in text.lower()):
            kind = "people"
        elif category == "personal" and DEBT_HINT.search(text):
            kind = "debt"
        else:
            continue
        amounts = [float(item.get("debit") or 0) for item in items]
        typical = sorted(amounts)[len(amounts) // 2]
        candidates.append(
            {
                "name": name,
                "kind": kind,
                "months": sorted(months),
                "typical": round(typical, 2),
                "i": [item["i"] for item in items[:18]],
            }
        )
    candidates.sort(key=lambda item: float(item.get("typical") or 0), reverse=True)
    return candidates[:20]


def _binding_hint(rows: list[dict]) -> str | None:
    months: dict[str, float] = {}
    for row in rows:
        key = str(row.get("date") or "")[:7]
        if len(key) < 7:
            continue
        credit = float(row.get("credit") or 0)
        debit = float(row.get("debit") or 0)
        category = row.get("category")
        earned = credit if category in {"business_in", "salary"} else 0.0
        # Strip dressing: ignore cash_in as earned; ignore self_out as ops drain for sizing.
        if category == "cash_in":
            credit = 0.0
        if category == "self_out":
            debit = 0.0
        ops = 0.0
        if category in {"emi", "rent", "supplier", "utilities", "tax", "bounce_charge"}:
            ops = debit
        elif category == "personal" and DEBT_HINT.search(str(row.get("description") or "")):
            ops = debit
        months[key] = months.get(key, 0.0) + earned - ops
    if not months:
        return None
    weak = min(months.items(), key=lambda item: item[1])
    return weak[0]


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
    structural = prepared.get("structural") or structural_intel(rows)
    brief = {
        "structural": {
            "archetype": structural.get("archetype"),
            "salaryShare": structural.get("salaryShare"),
            "cashInShare": structural.get("cashInShare"),
            "opaqueCash": structural.get("opaqueCash"),
            "binding_hint": structural.get("binding_hint"),
            "cash_chains": structural.get("cash_chains") or [],
            "obligation_candidates": structural.get("obligation_candidates") or [],
        },
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

    structural = prepared.get("structural") or structural_intel(rows)
    model_loops = _pairs(None, prepared["proposed_loops"])
    extra_loops = _pairs(decision.get("loops"), []) if decision and "loops" in decision else []
    seen_loops = set()
    loop_ids = []
    for credits, debits, detail in model_loops + extra_loops:
        key = (tuple(credits), tuple(debits))
        if key in seen_loops:
            continue
        if any(_noisy_loop(rows[i], rows[j]) for i in credits for j in debits if 0 <= i < len(rows) and 0 <= j < len(rows)):
            continue
        amount = sum(float(rows[i].get("credit") or 0) for i in credits if 0 <= i < len(rows))
        if amount < 500:
            continue
        seen_loops.add(key)
        loop_ids.append((credits, debits, detail, amount))
    loop_ids.sort(key=lambda item: item[3], reverse=True)
    loop_ids = loop_ids[:5]
    aside = []
    notes = []
    loop_keys: list[str] = []
    loop_total = 0.0
    for credits, debits, detail, amount in loop_ids:
        credit_keys = [_key(rows, i) for i in credits]
        debit_keys = [_key(rows, i) for i in debits]
        aside.extend(key for key in credit_keys if key)
        loop_keys.extend(key for key in credit_keys + debit_keys if key)
        loop_total += amount
    if loop_ids:
        notes.append(
            {
                "code": "judge-loop-summary",
                "title": "The same rupee comes back",
                "detail": f"{len(loop_ids)} same-rupee loops total {_rupees(loop_total)} leaving earned inflow.",
                "severity": "watch",
                "keys": list(dict.fromkeys(loop_keys))[:40],
            }
        )

    obligation_keys: list[str] = []
    self_keys: list[str] = []
    people_keys: list[str] = []
    obligations = decision.get("obligations") if isinstance(decision.get("obligations"), list) else None
    if not obligations:
        obligations = [
            {"i": item.get("i"), "kind": item.get("kind"), "detail": f"{item.get('name')} repeats.", "late": False}
            for item in structural.get("obligation_candidates") or []
        ]
    debt_groups: list[tuple[list[str], str, bool]] = []
    self_groups: list[tuple[list[str], str]] = []
    people_groups: list[tuple[list[str], str]] = []
    for item in obligations:
        if not isinstance(item, dict):
            continue
        keys = [key for key in (_key(rows, i) for i in _ints(item.get("i"))) if key]
        if not keys:
            continue
        kind = str(item.get("kind") or "debt").strip().lower()
        if kind not in {"debt", "self", "people"}:
            kind = "debt"
        detail = str(item.get("detail") or "").strip()
        if kind == "debt":
            obligation_keys.extend(keys)
            debt_groups.append((keys, detail, bool(item.get("late"))))
        elif kind == "self":
            self_keys.extend(keys)
            self_groups.append((keys, detail))
        else:
            people_keys.extend(keys)
            people_groups.append((keys, detail))
    if debt_groups:
        keys = [key for group in debt_groups for key in group[0]]
        late = any(group[2] for group in debt_groups)
        notes.append(
            {
                "code": "judge-debt-summary",
                "title": "A repeating debit is already debt",
                "detail": f"{len(debt_groups)} debt series are counted with obligations"
                + (" and at least one looks late." if late else ".")
                + " Self-transfers and people pays stay out of EMI.",
                "severity": "watch",
                "keys": list(dict.fromkeys(keys))[:40],
            }
        )
    if self_groups:
        keys = [key for group in self_groups for key in group[0]]
        notes.append(
            {
                "code": "judge-self-summary",
                "title": "Money hops to another own account",
                "detail": f"{len(self_groups)} self-transfer series are on the file. These are not treated as loan EMI.",
                "severity": "info",
                "keys": list(dict.fromkeys(keys))[:40],
            }
        )
    if people_groups:
        keys = [key for group in people_groups for key in group[0]]
        notes.append(
            {
                "code": "judge-people-summary",
                "title": "Repeating payments to people",
                "detail": f"{len(people_groups)} people series repeat on the file. These are not treated as loan EMI.",
                "severity": "info",
                "keys": list(dict.fromkeys(keys))[:40],
            }
        )

    cash_chains = decision.get("cash_chains") if isinstance(decision.get("cash_chains"), list) else None
    if not cash_chains:
        cash_chains = structural.get("cash_chains") or []
    cash_chain_keys: list[str] = []
    cash_total = 0.0
    for item in cash_chains[:12]:
        if not isinstance(item, dict):
            continue
        cash_i = _ints(item.get("cash_i"))
        out_i = _ints(item.get("out_i"))
        keys = [key for key in (_key(rows, i) for i in cash_i + out_i) if key]
        if not keys:
            continue
        cash_chain_keys.extend(keys)
        cash_total += sum(float(rows[i].get("credit") or 0) for i in cash_i if 0 <= i < len(rows))
    if cash_chain_keys:
        count = min(len(cash_chains), 12)
        notes.append(
            {
                "code": "judge-cash-summary",
                "title": "Cash deposits leave the account quickly",
                "detail": f"{count} cash deposits totaling {_rupees(cash_total)} leave as self or transfer within a few days and are not treated as earned inflow.",
                "severity": "breach" if structural.get("opaqueCash") else "watch",
                "keys": list(dict.fromkeys(cash_chain_keys))[:40],
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

    month_keys = {str(row.get("date") or "")[:7] for row in rows}
    binding = str(decision.get("binding_month") or "")
    if binding not in month_keys:
        binding = str(structural.get("binding_hint") or "")
    if binding not in month_keys:
        binding = ""
    if binding:
        notes.append(
            {
                "code": "judge-bind",
                "title": f"{_month_label(binding)} sizes the facility",
                "detail": _sentence(
                    decision.get("binding_detail"),
                    "Cash deposits and self-transfers are stripped before this month is used to size.",
                ),
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

    # Party merges stay on the parties object for grouping; do not flood the officer notes list.
    merged_parties = [party for party in parties if len([a for a in party["aliases"] if a and a != party["name"]]) > 0]
    if merged_parties:
        sample = ", ".join(party["name"] for party in merged_parties[:3])
        extra = len(merged_parties) - 3
        detail = f"{len(merged_parties)} name groups were joined on this file"
        if sample:
            detail += f", including {sample}"
            if extra > 0:
                detail += f" and {extra} more"
        detail += "."
        notes.append(
            {
                "code": "judge-party-summary",
                "title": "Some payers appear under more than one spelling",
                "detail": detail,
                "severity": "info",
                "keys": [key for party in merged_parties[:5] for key in party["keys"][:4]],
            }
        )

    investing_keys = []
    for item in decision.get("investing") or []:
        if isinstance(item, dict):
            investing_keys.extend(key for key in (_key(rows, i) for i in _ints(item.get("i"))) if key)

    archetype = str(decision.get("archetype") or structural.get("archetype") or "mixed").strip().lower()
    if archetype not in {"salary", "trader", "mixed"}:
        archetype = structural.get("archetype") or "mixed"

    return {
        "parties": parties,
        "asideKeys": aside,
        "obligationKeys": list(dict.fromkeys(obligation_keys)),
        "selfKeys": list(dict.fromkeys(self_keys)),
        "peopleKeys": list(dict.fromkeys(people_keys)),
        "cashChainKeys": list(dict.fromkeys(cash_chain_keys)),
        "investingKeys": investing_keys,
        "archetype": archetype,
        "bindingMonth": binding or None,
        "missingMonths": missing_months(sorted({str(row.get("date") or "")[:7] for row in rows if len(str(row.get("date") or "")) >= 7})),
        "notes": notes,
        "conduct": _conduct(decision.get("conduct"), archetype=archetype, opaque_cash=bool(structural.get("opaqueCash"))),
    }


def _conduct(raw, archetype: str = "mixed", opaque_cash: bool = False) -> dict | None:
    if not isinstance(raw, dict):
        raw = {}
    consistency = str(raw.get("consistency") or "").strip().lower()
    risk = str(raw.get("risk") or "").strip().lower()
    spender = str(raw.get("spender") or "").strip()[:48]
    line = str(raw.get("line") or "").strip()[:220]
    if consistency not in {"steady", "uneven", "inconsistent"}:
        consistency = "uneven"
    if risk not in {"contained", "watch", "high"}:
        risk = "watch" if opaque_cash else "contained"
    if opaque_cash and risk == "contained":
        risk = "watch"
    if not spender:
        spender = {"salary": "Salaried", "trader": "Trade", "mixed": "Mixed"}.get(archetype, "Mixed")
    if not line:
        if opaque_cash:
            line = "Eligible with watch: cash deposits dress the months and are not treated as earned inflow."
        elif archetype == "salary":
            line = "Eligible if cash left after salary commitments covers a new EMI."
        else:
            line = "Eligible if a typical month still leaves room after obligations."
    return {"spender": spender, "consistency": consistency, "risk": risk, "line": line}


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
        kind = str(item.get("kind") or "debt").strip().lower()
        if kind != "debt":
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


def _month_label(key: str) -> str:
    try:
        return datetime.strptime(key, "%Y-%m").strftime("%b %y")
    except ValueError:
        return key


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
