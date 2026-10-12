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

  if (credit > 0) return "business_in";
  if (debit >= 5000) return "supplier";
  if (debit > 0) return "personal";
  return credit > 0 ? "other_in" : "other_out";
}

export function counterparty(description: string) {
  const cleaned = description
    .replace(/^(NEFT|RTGS|IMPS|UPI|NACH|ACH|INB|CLG)\b[/\-\s]*/i, "")
    .replace(/^(CHQ RETURN|CASH DEPOSIT|ATM CASH WDL|GST CHALLAN)\b[/\-\s]*/i, "");
  const part = cleaned.split(/[/-]/)[0]?.trim() ?? "";
  const name = part.replace(/\s+/g, " ").slice(0, 42);
  return name || "Unknown";
}
