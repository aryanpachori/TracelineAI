"""Names pulled out of a narration, and stable keys for statement rows.

Merging two names is a model decision. This module only finds the words to compare.
"""

import re

SKIP = {
    "neft", "imps", "rtgs", "upi", "nach", "ecs", "ach", "atm", "cash", "wdl",
    "deposit", "branch", "oksbi", "okaxis", "okhdfcbank", "okicici", "ybl", "ibl",
    "axl", "payment", "invoice", "purchase", "bill", "transfer", "trf", "self",
    "from", "savings", "textiles", "textile", "traders", "stores", "agencies",
    "industries", "enterprise", "private", "limited", "pvt", "ltd", "mills",
    "mill", "garments", "fabrics", "collections", "boutique", "wholesale",
    "house", "works", "receipt", "sales", "stock", "yarn", "grey", "cloth",
}


def _is_ref_noise(compact: str) -> bool:
    """UPI / bank reference blobs are not party names."""
    if len(compact) >= 16 and sum(ch.isdigit() for ch in compact) >= 8:
        return True
    if re.fullmatch(r"(ycd|ici|crd|sbi|hdf|ubi|axl|yes)[a-z0-9]{10,}", compact):
        return True
    return False


def display_name(narration: str) -> str:
    kept: list[str] = []
    for part in re.split(r"[/|]", narration or ""):
        piece = re.sub(r"\s+", " ", part).strip(" -")
        compact = re.sub(r"[^a-z0-9]", "", piece.lower())
        if not piece or compact in SKIP or compact.isdigit() or len(compact) < 3:
            continue
        if re.fullmatch(r"[a-z]*\d{3,}", compact):
            continue
        if _is_ref_noise(compact):
            continue
        kept.append(piece)
    if not kept:
        return ""
    kept.sort(key=lambda item: len(re.sub(r"[^A-Za-z]", "", item)), reverse=True)
    return kept[0][:48]


def tokens(name: str) -> set[str]:
    found = set()
    for part in re.split(r"[^a-z0-9]+", name.lower()):
        if len(part) >= 4 and part not in SKIP:
            found.add(part)
    return found


def share_token(a: str, b: str) -> bool:
    return bool(tokens(a) & tokens(b))


def stamp_keys(rows: list[dict]) -> list[dict]:
    seen: dict[str, int] = {}
    stamped = []
    for row in rows:
        if row.get("key"):
            stamped.append(row)
            continue
        base = f"{row.get('date', '')}|{row.get('description', '')}|{row.get('debit', 0)}|{row.get('credit', 0)}"
        seen[base] = seen.get(base, 0) + 1
        item = dict(row)
        item["key"] = f"{base}|{seen[base]}"
        stamped.append(item)
    return stamped
