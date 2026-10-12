import { buildSpendBrief, writeSpendSummary } from "@/lib/spend-summary";
import type { Analysis, Policy, Txn } from "@/lib/types";

export function buildCaseFile(analysis: Analysis, policy: Policy, caseRef: string, fileName: string) {
  const spending = buildSpendBrief(analysis);
  return {
    product: "Traceline",
    caseRef,
    fileName,
    period: analysis.periodLabel,
    from: analysis.start,
    to: analysis.end,
    coverage: analysis.dataConfidence,
    summary: analysis.summary,
    spending: {
      kind: spending.kind,
      reading: writeSpendSummary(spending),
      total: spending.totalSpend,
      top: spending.top,
      peakMonth: spending.peakMonth,
      quietMonth: spending.quietMonth,
    },
    terms: policy,
    grade: {
      letter: analysis.grade.letter,
      label: analysis.grade.label,
      points: analysis.grade.points,
      moved: analysis.grade.rules,
    },
    capacity: analysis.capacity,
    metrics: analysis.metrics,
    facilities: analysis.flows.facilities,
    recurring: analysis.flows.series,
    rails: analysis.flows.rails,
    monthPattern: analysis.flows.months,
    groups: analysis.groups,
    reasons: analysis.reasons,
    checks: analysis.integrity,
    months: analysis.months,
    payers: analysis.counterparties,
    outflowMix: analysis.outflowMix,
    rowCount: analysis.txns.length,
    statement: statementCsv(analysis.txns),
    transactions: analysis.txns,
  };
}

function statementCsv(txns: Txn[]) {
  const lines = ["Date,Description,Debit,Credit,Balance,Tag"];
  txns.forEach((txn) => {
    const [year, month, day] = txn.date.split("-");
    lines.push(
      [
        `${day}-${month}-${year}`,
        csvEscape(txn.description),
        txn.debit ? String(txn.debit) : "",
        txn.credit ? String(txn.credit) : "",
        txn.balance == null ? "" : String(txn.balance),
        csvEscape(txn.category),
      ].join(","),
    );
  });
  return lines.join("\n");
}

function csvEscape(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
