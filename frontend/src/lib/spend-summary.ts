import { inr, pct } from "./format";
import type { Analysis } from "./types";

export type SpendBrief = {
  totalSpend: number;
  top: { id: string; name: string; amount: number; share: number; merchant: string | null }[];
  peakMonth: { key: string; label: string; amount: number; lead: string };
  quietMonth: { key: string; label: string; amount: number };
  kind: string;
  kindDetail: string;
};

const OPERATING = ["suppliers", "utilities", "tax"];
const FIXED = ["emi", "rent", "insurance", "subscriptions"];
const PERSONAL = ["food", "fuel", "healthcare", "shopping", "travel", "cards", "people", "shops", "cash"];

export function buildSpendBrief(analysis: Analysis): SpendBrief {
  const spend = analysis.groups.spend;
  const total = spend.reduce((sum, group) => sum + group.amount, 0);
  const shareOf = (ids: string[]) => {
    const amount = spend.filter((group) => ids.includes(group.id)).reduce((sum, group) => sum + group.amount, 0);
    return total > 0 ? amount / total : 0;
  };
  const operating = shareOf(OPERATING);
  const fixed = shareOf(FIXED);
  const personal = shareOf(PERSONAL);

  let kind = "Mixed spender";
  let kindDetail = "Outflows are spread across business costs, fixed payments, and personal spends.";
  if (operating >= 0.45) {
    kind = "Operating spender";
    kindDetail = "Business costs carry the account. Loan payments, rent, and personal spends sit underneath.";
  } else if (fixed >= 0.35 && fixed >= personal) {
    kind = "Fixed-commitment spender";
    kindDetail = "EMIs, rent, insurance, and subscriptions take a large share before day-to-day spends.";
  } else if (personal >= 0.3 && personal >= operating) {
    kind = "Personal spender";
    kindDetail = "Food, fuel, shopping, healthcare, and cash withdrawals lead the outflows.";
  }

  const nameOf = (id: string) => spend.find((group) => group.id === id)?.name ?? (id === "rest" ? "smaller groups" : "spending");
  const months = analysis.groups.months.map((month) => {
    const entries = Object.entries(month.values);
    const amount = entries.reduce((sum, [, value]) => sum + value, 0);
    const leadId = entries.sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    return { key: month.key, label: month.label, amount, lead: nameOf(leadId) };
  });
  const peak = months.length ? months.reduce((best, month) => (month.amount > best.amount ? month : best)) : undefined;
  const quiet = months.length ? months.reduce((best, month) => (month.amount < best.amount ? month : best)) : undefined;

  return {
    totalSpend: Math.round(total),
    top: spend.slice(0, 3).map((group) => ({
      id: group.id,
      name: group.name,
      amount: Math.round(group.amount),
      share: group.share,
      merchant: group.merchants[0]?.name ?? null,
    })),
    peakMonth: peak
      ? { key: peak.key, label: peak.label, amount: Math.round(peak.amount), lead: peak.lead }
      : { key: "", label: "—", amount: 0, lead: "spending" },
    quietMonth: quiet ? { key: quiet.key, label: quiet.label, amount: Math.round(quiet.amount) } : { key: "", label: "—", amount: 0 },
    kind,
    kindDetail,
  };
}

const KEPT = new Set(["hdfc", "lic", "atm", "gst", "upi", "neft", "imps", "rtgs", "nach", "hpcl", "bpcl", "iocl", "cbdt", "bescom"]);
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function spoken(name: string) {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function proper(name: string) {
  return name
    .toLowerCase()
    .split(/(\s+)/)
    .map((part) => {
      if (!part.trim()) return part;
      if (KEPT.has(part) || /^xx\d+$/i.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
}

function fullMonth(key: string, fallback: string) {
  const [year, month] = key.split("-").map(Number);
  if (!year || !month || !FULL_MONTHS[month - 1]) return fallback;
  return `${FULL_MONTHS[month - 1]} ${year}`;
}

export function writeSpendSummary(brief: SpendBrief) {
  const [first, second, third] = brief.top;
  if (!first) return "No spending rows were found on this statement.";
  const merchant = first.merchant ? `, mostly ${proper(first.merchant)}` : "";
  const next = [second, third].filter((group) => group && group.amount > 0);
  const nextLine = next.length
    ? ` Next ${next.length === 1 ? "is" : "are"} ${next.map((group) => spoken(group.name)).join(" and ")}.`
    : "";
  const heavy =
    brief.peakMonth.amount > 0
      ? ` ${fullMonth(brief.peakMonth.key, brief.peakMonth.label)} was the heaviest month, led by ${spoken(brief.peakMonth.lead)}. ${fullMonth(brief.quietMonth.key, brief.quietMonth.label)} was the lightest.`
      : "";
  return `${brief.kind}. The largest outflow is ${spoken(first.name)}, ${inr(first.amount, 0)} and ${pct(first.share)} of spending${merchant}.${nextLine}${heavy} ${brief.kindDetail}`;
}
