import type { Category, TxnInput } from "./types";

export function categorize(txn: TxnInput): Category {
  const text = txn.description.toLowerCase();
  const credit = txn.credit;
  const debit = txn.debit;

  if (/chq.*ret|cheque ret|ecs ret|nach ret|bounce|dishonou?r|insufficient funds|return charges/.test(text)) {
    if (credit > 0) return "bounce_reversal";
    return debit >= 1000 ? "bounce_reversal" : "bounce_charge";
  }

  if (credit > 0 && /loan disb|term loan|disbursement|business loan|personal loan/.test(text)) {
    return "loan_in";
  }

  if (/self|own a\/c|own account/.test(text)) {
    return credit > 0 ? "self_in" : "self_out";
  }

  if (credit > 0 && /cash dep|by cash|cash deposit/.test(text)) return "cash_in";
  if (credit > 0 && /transfer from|trf from|received from/.test(text)) return "transfer_in";
  if (credit > 0 && /salary|payroll/.test(text)) return "salary";

  if (debit > 0 && /emi|loan a\/c/.test(text)) return "emi";
  if (debit > 0 && /\brent\b/.test(text)) return "rent";
  if (debit > 0 && /gst|tds|income tax|cbdt|challan/.test(text)) return "tax";
  if (debit > 0 && /electric|bescom|torrent power|water bill|broadband|jio|airtel/.test(text)) {
    return "utilities";
  }
  if (debit > 0 && /atm|cash wdl|cwdr|nfs/.test(text)) return "cash_out";
  if (debit > 0 && /swiggy|zomato|zepto|bigbasket|petrol|hpcl|bpcl|ioc/.test(text)) return "personal";
  if (debit > 0 && /mills|dye|packaging|supplier|purchase/.test(text)) return "supplier";
  if (/upi\/p2a|imps\/p2a|upi\/p2p/.test(text)) return credit > 0 ? "transfer_in" : "transfer_out";

  if (credit > 0) return "business_in";
  if (debit >= 5000) return "supplier";
  if (debit > 0) return "personal";
  return credit > 0 ? "other_in" : "other_out";
}

const SKIP = new Set([
  "upi", "imps", "neft", "rtgs", "nach", "ach", "ecs", "pos", "ecom", "pur", "p2a", "p2m", "p2v", "p2p",
  "cradj", "nbsm", "brn", "atm", "sak", "sb", "paid", "payvia", "paymen", "pay", "via", "rem", "sent", "usi",
  "no", "to", "collect", "collec", "payment", "ybs", "ltd", "limited", "bank",
]);

const BRANDS: [RegExp, string][] = [
  [/youtube/, "YouTube"],
  [/netflix/, "Netflix"],
  [/spotify/, "Spotify"],
  [/swiggy/, "Swiggy"],
  [/zomato/, "Zomato"],
  [/zepto/, "Zepto"],
  [/blinkit/, "Blinkit"],
  [/dominos?/, "Domino's"],
  [/amazon/, "Amazon"],
  [/flipkart/, "Flipkart"],
  [/myntra/, "Myntra"],
  [/meesho/, "Meesho"],
  [/irctc/, "IRCTC"],
  [/zerodha/, "Zerodha"],
  [/\bcred\b/, "CRED"],
  [/airtel/, "Airtel"],
  [/uber/, "Uber"],
  [/\bola\b/, "Ola"],
  [/policybazaar/, "Policybazaar"],
];

export function counterparty(description: string) {
  const text = description.toLowerCase();
  if (/int\.pd|interest paid/.test(text)) return "Interest";
  if (/^atm|atm-cash|atm cash/.test(text)) return "ATM";
  if (/cash dep|self cash dep/.test(text)) return "Cash deposit";
  for (const [pattern, brand] of BRANDS) {
    if (pattern.test(text)) return brand;
  }
  const parts = description.split(/[/-]/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const part of parts) {
    const compact = part.replace(/\s/g, "");
    if (compact.length < 2 || /^\d+$/.test(compact) || /^[a-z]*\d{6,}/i.test(compact)) continue;
    const words = part.split(" ").filter(Boolean);
    if (words.every((word) => SKIP.has(word.toLowerCase().replace(/[^a-z0-9]/g, "")))) continue;
    if (/\b(bank|limited|ltd|ybs)\b/i.test(part) && !/\b(broking|clearing|payments|food|cafe|store)\b/i.test(part)) continue;
    return presentName(part);
  }
  return "Unknown";
}

export function partyKind(description: string, category?: string) {
  const text = description.toLowerCase();
  if (category === "self_in" || category === "self_out" || /\bself\b|own account|own a\/c/.test(text)) return "Self";
  if (/int\.pd|interest paid|chrgs|charges|gst/.test(text)) return "Bank";
  if (/cash dep|^atm|atm-cash|atm cash/.test(text)) return "Cash";
  if (/upi\/p2a|imps\/p2a|upi\/p2p|@(?:ok\w*|ybl|axl|ibl|pty|upi)\b/.test(text)) return "Person";
  if (/upi\/p2m|pos\/|^ecom|nach|mandate/.test(text)) return "Merchant";
  return "Transfer";
}

export function railLabel(description: string) {
  const text = description.toUpperCase();
  if (text.includes("UPI/") || text.includes("/UPI")) return "UPI";
  if (text.startsWith("NEFT")) return "NEFT";
  if (text.startsWith("IMPS")) return "IMPS";
  if (text.startsWith("RTGS")) return "RTGS";
  if (text.startsWith("POS") || text.startsWith("ECOM")) return "Card";
  if (/^(NACH|ECS|ACH)\b/.test(text)) return "NACH";
  if (text.includes("ATM") || text.includes("CASH")) return "Cash";
  return "Transfer";
}

function presentName(raw: string) {
  const cleaned = raw
    .replace(/\b(ipl(\s+pa\s+cb\s+exp)?|pa\s+cb\s+exp|dscnb\s+a?|mfss\s+se|pvt|private)\b/gi, " ")
    .replace(/[|*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const titled = cleaned
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return titled.slice(0, 42) || "Unknown";
}
