export function inr(value: number, digits = 0) {
  const sign = value < 0 ? "-" : "";
  const formatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Math.abs(value));
  return sign + formatted;
}

export function inrBand(low: number, high: number) {
  if (high <= 0) return "—";
  if (Math.round(low) === Math.round(high)) return inrCompact(high);
  return `${inrCompact(low)} – ${inrCompact(high)}`;
}

export function inrCompact(value: number) {
  const sign = value < 0 ? "-" : "";
  const v = Math.abs(value);
  if (v >= 1_00_00_000) return `${sign}₹${trim(v / 1_00_00_000)}Cr`;
  if (v >= 1_00_000) return `${sign}₹${trim(v / 1_00_000)}L`;
  if (v >= 1_000) return `${sign}₹${trim(v / 1_000)}k`;
  return inr(value, 0);
}

function trim(n: number) {
  const digits = n >= 10 ? 1 : 2;
  return n.toFixed(digits).replace(/\.0$/, "");
}

export function pct(ratio: number, digits = 0) {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function signedPct(ratio: number) {
  if (!Number.isFinite(ratio)) return "—";
  const value = (ratio * 100).toFixed(0);
  return `${ratio > 0 ? "+" : ""}${value}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${String(year).slice(2)}`;
}

export function prettyDate(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function monthKey(iso: string) {
  return iso.slice(0, 7);
}

export const CATEGORY_LABEL: Record<string, string> = {
  business_in: "Business receipt",
  salary: "Salary",
  transfer_in: "Transfer in",
  loan_in: "Loan credit",
  self_in: "Self-transfer in",
  cash_in: "Cash deposit",
  emi: "EMI",
  rent: "Rent",
  supplier: "Supplier",
  utilities: "Utilities",
  tax: "Tax",
  bounce_reversal: "Returned instrument",
  bounce_charge: "Bounce charge",
  cash_out: "Cash withdrawal",
  personal: "Personal",
  self_out: "Self-transfer out",
  transfer_out: "Transfer out",
  other_in: "Other credit",
  other_out: "Other debit",
};
