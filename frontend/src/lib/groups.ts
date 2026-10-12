import { pct } from "./format";
import type { GroupReport, MonthPoint, Txn } from "./types";

type Bucket = {
  id: string;
  name: string;
  side: "in" | "out";
  color: string;
};

const SPEND: Record<string, Bucket> = {
  returns: { id: "returns", name: "Returned cheques", side: "out", color: "#e11d48" },
  charges: { id: "charges", name: "Bank charges", side: "out", color: "#fb7185" },
  emi: { id: "emi", name: "Loan EMIs", side: "out", color: "#f97316" },
  rent: { id: "rent", name: "Rent", side: "out", color: "#d97706" },
  insurance: { id: "insurance", name: "Insurance", side: "out", color: "#7c3aed" },
  subscriptions: { id: "subscriptions", name: "Subscriptions", side: "out", color: "#2563eb" },
  food: { id: "food", name: "Food and groceries", side: "out", color: "#f59e0b" },
  fuel: { id: "fuel", name: "Fuel", side: "out", color: "#0d9488" },
  healthcare: { id: "healthcare", name: "Healthcare", side: "out", color: "#db2777" },
  shopping: { id: "shopping", name: "Shopping", side: "out", color: "#0284c7" },
  utilities: { id: "utilities", name: "Utilities", side: "out", color: "#64748b" },
  tax: { id: "tax", name: "Tax", side: "out", color: "#78716c" },
  suppliers: { id: "suppliers", name: "Suppliers", side: "out", color: "#059669" },
  cash: { id: "cash", name: "Cash withdrawals", side: "out", color: "#94a3b8" },
  self: { id: "self", name: "Transfers to self", side: "out", color: "#475569" },
  other: { id: "other", name: "Other spending", side: "out", color: "#cbd5e1" },
};

const INCOME: Record<string, Bucket> = {
  business: { id: "business", name: "Business receipts", side: "in", color: "#059669" },
  salary: { id: "salary", name: "Salary", side: "in", color: "#2563eb" },
  loan: { id: "loan", name: "Loan credits", side: "in", color: "#e11d48" },
  self: { id: "self_in", name: "Transfers from self", side: "in", color: "#d97706" },
  cash: { id: "cash_in", name: "Cash deposits", side: "in", color: "#94a3b8" },
  transfer: { id: "transfer_in", name: "Other transfers in", side: "in", color: "#475569" },
  cheques: { id: "cheques_in", name: "Cheques later returned", side: "in", color: "#fb7185" },
  other: { id: "other_in", name: "Other credits", side: "in", color: "#cbd5e1" },
};

export function buildGroups(txns: Txn[], months: MonthPoint[]): GroupReport {
  const placed = txns.map((txn) => ({ txn, bucket: assign(txn) }));
  const spend = collect(placed.filter((row) => row.bucket.side === "out"));
  const income = collect(placed.filter((row) => row.bucket.side === "in"));
  const chartIds = spend.slice(0, 6).map((group) => group.id);
  const monthRows = months.map((month) => {
    const values: Record<string, number> = {};
    placed
      .filter((row) => row.bucket.side === "out" && row.txn.date.startsWith(month.key))
      .forEach((row) => {
        const id = chartIds.includes(row.bucket.id) ? row.bucket.id : "rest";
        values[id] = (values[id] ?? 0) + (row.txn.debit || row.txn.credit);
      });
    return { key: month.key, label: month.label, values };
  });

  return {
    reading: writeReading(txns.length, spend, income),
    spend,
    income,
    months: monthRows,
    chartIds,
  };
}

export function groupName(report: GroupReport, txnId: string) {
  const found = [...report.spend, ...report.income].find((group) => group.txnIds.includes(txnId));
  return found?.name ?? "";
}

function assign(txn: Txn): Bucket {
  const text = txn.description.toLowerCase();
  if (txn.debit > 0) {
    if (txn.category === "bounce_reversal") return SPEND.returns;
    if (txn.category === "bounce_charge") return SPEND.charges;
    if (txn.category === "emi" || /\bemi\b/.test(text)) return SPEND.emi;
    if (txn.category === "rent" || /\brent\b/.test(text)) return SPEND.rent;
    if (/lic|insurance|premium/.test(text)) return SPEND.insurance;
    if (/netflix|spotify|hotstar|disney|youtube|google workspace|google one|adobe|microsoft 365|prime video|subscription/.test(text)) {
      return SPEND.subscriptions;
    }
    if (/swiggy|zomato|zepto|bigbasket|blinkit|restaurant|dominos|pizza/.test(text)) return SPEND.food;
    if (/petrol|diesel|hpcl|bpcl|iocl|fuel|indian oil/.test(text)) return SPEND.fuel;
    if (/apollo|pharmacy|medical|hospital|clinic|pharma/.test(text)) return SPEND.healthcare;
    if (/amazon|flipkart|myntra|ajio|nykaa|meesho/.test(text)) return SPEND.shopping;
    if (txn.category === "utilities") return SPEND.utilities;
    if (txn.category === "tax") return SPEND.tax;
    if (txn.category === "supplier") return SPEND.suppliers;
    if (txn.category === "cash_out" || /atm|cash wdl/.test(text)) return SPEND.cash;
    if (txn.category === "self_out") return SPEND.self;
    return SPEND.other;
  }
  if (txn.category === "bounce_reversal") return INCOME.cheques;
  if (txn.category === "business_in") return INCOME.business;
  if (txn.category === "salary") return INCOME.salary;
  if (txn.category === "loan_in") return INCOME.loan;
  if (txn.category === "self_in") return INCOME.self;
  if (txn.category === "cash_in") return INCOME.cash;
  if (txn.category === "transfer_in") return INCOME.transfer;
  return INCOME.other;
}

function collect(rows: { txn: Txn; bucket: Bucket }[]) {
  const total = rows.reduce((sum, row) => sum + amountOf(row.txn), 0);
  const map = new Map<string, { bucket: Bucket; txns: Txn[] }>();
  rows.forEach((row) => {
    const current = map.get(row.bucket.id) ?? { bucket: row.bucket, txns: [] };
    current.txns.push(row.txn);
    map.set(row.bucket.id, current);
  });
  return [...map.values()]
    .map((entry) => {
      const amount = entry.txns.reduce((sum, txn) => sum + amountOf(txn), 0);
      return {
        id: entry.bucket.id,
        name: entry.bucket.name,
        side: entry.bucket.side,
        color: entry.bucket.color,
        amount,
        count: entry.txns.length,
        share: total > 0 ? amount / total : 0,
        txnIds: entry.txns.map((txn) => txn.id),
        merchants: merchantsOf(entry.txns),
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

function merchantsOf(txns: Txn[]) {
  const map = new Map<string, { amount: number; count: number; txnIds: string[] }>();
  txns.forEach((txn) => {
    const name = partyName(txn);
    const current = map.get(name) ?? { amount: 0, count: 0, txnIds: [] };
    current.amount += amountOf(txn);
    current.count += 1;
    current.txnIds.push(txn.id);
    map.set(name, current);
  });
  return [...map.entries()]
    .map(([name, value]) => ({ name, amount: value.amount, count: value.count, txnIds: value.txnIds }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
}

function partyName(txn: Txn) {
  if (txn.counterparty && txn.counterparty !== "Unknown") return txn.counterparty;
  if (/atm/i.test(txn.description)) return "ATM";
  return txn.description.split(/[/-]/)[0]?.trim().slice(0, 42) || "Unknown";
}

function amountOf(txn: Txn) {
  return txn.debit || txn.credit;
}

function writeReading(rows: number, spend: GroupReport["spend"], income: GroupReport["income"]) {
  const lead = spend.slice(0, 3).map((group) => (group.name === "Loan EMIs" ? "loan EMIs" : group.name.toLowerCase()));
  const incomeLead = income[0];
  const spendLine = lead.length
    ? `Spending is led by ${joinNames(lead)}.`
    : "No spending rows were found.";
  const incomeLine = incomeLead
    ? `Income is led by ${incomeLead.name.toLowerCase()}, ${pct(incomeLead.share)} of credits.`
    : "No credit rows were found.";
  return `AI read all ${rows} rows and split the account into ${spend.length} spending groups and ${income.length} income groups. ${spendLine} ${incomeLine} Open a group for the merchants and the statement lines inside it.`;
}

function joinNames(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

