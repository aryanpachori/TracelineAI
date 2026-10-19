import { inrCompact } from "./format";
import type {
  BackendMetrics,
  Character,
  Conduct,
  EligibilityWhy,
  GroupReport,
  Judgment,
  MonthPoint,
  Reason,
} from "./types";

const KINDS: { id: string; title: string; groups: string[]; line: string }[] = [
  { id: "trade", title: "Trade spender", groups: ["suppliers"], line: "Suppliers lead what leaves the account." },
  { id: "debt", title: "Debt spender", groups: ["emi"], line: "Instalments lead what leaves the account." },
  { id: "cash", title: "Cash spender", groups: ["cash"], line: "Cash withdrawals lead what leaves, so the use stays hidden." },
  {
    id: "lifestyle",
    title: "Lifestyle spender",
    groups: ["shopping", "travel", "subscriptions", "cards"],
    line: "Shopping, travel, and cards lead what leaves.",
  },
  {
    id: "household",
    title: "Household spender",
    groups: ["food", "fuel", "utilities", "rent", "healthcare", "insurance", "tax"],
    line: "Food, fuel, rent, and utilities lead what leaves.",
  },
  { id: "people", title: "Pays people", groups: ["people"], line: "Payments to people lead what leaves." },
];

const RISK_TITLE = { contained: "Contained", watch: "Watch", high: "High" } as const;
const FLOW_TITLE = { steady: "Steady", uneven: "Uneven", inconsistent: "Inconsistent" } as const;
const ARCHETYPE_LINE = {
  salary: "Salary leads earned inflow on this file.",
  trader: "Business receipts lead earned inflow on this file.",
  mixed: "Salary and other credits share earned inflow.",
} as const;

export function readCharacter(
  months: MonthPoint[],
  groups: GroupReport,
  capable: boolean,
  signals?: {
    bounces?: number;
    bounceCap?: number;
    obligationRatio?: number | null;
    conduct?: Conduct | null;
    judgment?: Judgment | null;
    backendMetrics?: BackendMetrics | null;
    policyMaxObligation?: number;
    reasons?: Reason[];
  },
): Character {
  const conduct = signals?.conduct;
  const bounces = signals?.bounces ?? 0;
  const bounceCap = signals?.bounceCap ?? 1;
  const obligationRatio = signals?.obligationRatio ?? null;
  const backend = signals?.backendMetrics;
  const judgment = signals?.judgment;
  const archetype =
    judgment?.archetype ||
    backend?.archetype ||
    (backend?.salaryShare != null && backend.salaryShare >= 0.5 ? "salary" : "mixed");
  const opaqueCash = Boolean(backend?.opaqueCash || (backend?.cashInShare != null && backend.cashInShare >= 0.25));
  const cashInShare = backend?.cashInShare ?? null;
  const spend = spender(groups);
  const flow = consistency(months, judgment?.bindingMonth ?? null);
  const local = riskOf(capable, spend.id, flow.tone, bounces, bounceCap, obligationRatio, opaqueCash);
  const modelAgrees = conduct && (capable || conduct.risk !== "contained");
  let tone = modelAgrees ? conduct.risk : local.tone;
  if (bounces > bounceCap) tone = "high";
  else if (opaqueCash && tone === "contained") tone = "watch";
  else if (tone === "contained" && (bounces > 0 || (obligationRatio != null && obligationRatio >= 0.4))) tone = "watch";

  const debtBreaks =
    obligationRatio != null &&
    signals?.policyMaxObligation != null &&
    obligationRatio > signals.policyMaxObligation;
  const notEligible = !capable || bounces > bounceCap || debtBreaks;
  let verdictLabel: Character["verdictLabel"] = "Eligible";
  if (notEligible) verdictLabel = "Not eligible";
  else if (tone === "watch" || tone === "high") verdictLabel = "Eligible with watch";

  const riskLine = modelAgrees && tone === conduct.risk ? conduct.line : local.line;
  const whyLine =
    conduct?.line ||
    (verdictLabel === "Not eligible"
      ? riskLine
      : verdictLabel === "Eligible with watch"
        ? riskLine
        : `${ARCHETYPE_LINE[archetype]} ${riskLine}`);

  const cashStructureLine =
    opaqueCash && cashInShare != null
      ? `Cash deposits are ${Math.round(cashInShare * 100)}% of credits and are not treated as earned inflow.`
      : opaqueCash
        ? "Cash deposits dress the months and are not treated as earned inflow."
        : null;

  const flowTone = conduct?.consistency ?? flow.tone;
  const eligibilityReasons = buildEligibilityReasons({
    archetype,
    archetypeLine: ARCHETYPE_LINE[archetype],
    obligationRatio,
    cashStructureLine,
    cashflow: flow.short && flowTone === "steady" ? "Consistently short" : FLOW_TITLE[flowTone],
    cashflowLine: flow.line,
    weakMonth: flow.weakMonth,
    bindingMonth: judgment?.bindingMonth ?? null,
    bounces,
    bounceCap,
    returnsLine:
      bounces <= 0
        ? "No returns in the last six months."
        : bounces > bounceCap
          ? `${bounces} returns in six months, above the file limit of ${bounceCap}.`
          : `${bounces} returns in six months, still inside the limit of ${bounceCap}.`,
    risk: RISK_TITLE[tone],
    riskLine,
    tone,
    groupId: spend.groupId,
    reasons: signals?.reasons ?? [],
    judgment,
  });

  return {
    spender: conduct?.spender || spend.title,
    spenderLine: spend.line,
    groupId: spend.groupId,
    cashflow: flow.short && flowTone === "steady" ? "Consistently short" : FLOW_TITLE[flowTone],
    cashflowLine: flow.line,
    weakMonth: flow.weakMonth,
    risk: RISK_TITLE[tone],
    riskLine,
    tone,
    returns: bounces,
    returnsLine:
      bounces <= 0
        ? "No returns in the last six months."
        : bounces > bounceCap
          ? `${bounces} returns in six months, above the file limit of ${bounceCap}.`
          : `${bounces} returns in six months, still inside the limit of ${bounceCap}.`,
    debtLoad: obligationRatio,
    debtLoadLine:
      obligationRatio == null
        ? null
        : `Real debts (EMI, rent, cards) are ${Math.round(obligationRatio * 100)}% of what comes in.`,
    archetype,
    archetypeLine: ARCHETYPE_LINE[archetype],
    cashStructureLine,
    verdictLabel,
    whyLine: whyLine.slice(0, 280),
    eligibilityReasons,
  };
}

function buildEligibilityReasons(input: {
  archetype: "salary" | "trader" | "mixed";
  archetypeLine: string;
  obligationRatio: number | null;
  cashStructureLine: string | null;
  cashflow: string;
  cashflowLine: string;
  weakMonth: string | null;
  bindingMonth: string | null;
  bounces: number;
  bounceCap: number;
  returnsLine: string;
  risk: string;
  riskLine: string;
  tone: "contained" | "watch" | "high";
  groupId: string | null;
  reasons: Reason[];
  judgment?: Judgment | null;
}): EligibilityWhy[] {
  const rows: EligibilityWhy[] = [];
  const shapeTitle =
    input.archetype === "salary" ? "Salaried account" : input.archetype === "trader" ? "Trader account" : "Mixed account";
  rows.push({
    id: "archetype",
    label: "Account shape",
    title: shapeTitle,
    detail: input.archetypeLine,
  });

  if (input.obligationRatio != null) {
    rows.push({
      id: "debt",
      label: "Debt load",
      title: `${Math.round(input.obligationRatio * 100)}% of inflow`,
      detail: `Real debts (EMI, rent, cards) take ${Math.round(input.obligationRatio * 100)}% of what comes in. Self-transfers are not counted as EMI.`,
      open: input.groupId ? { kind: "group", id: "emi" } : undefined,
    });
  }

  if (input.cashStructureLine) {
    const cashNote = input.judgment?.notes.find(
      (note) => note.code === "judge-cash-summary" || note.code.startsWith("judge-cash-"),
    );
    rows.push({
      id: "cash",
      label: "Cash structure",
      title: cashNote?.title || "Opaque cash deposits",
      detail: cashNote?.detail || input.cashStructureLine,
      open: cashNote ? { kind: "reason", code: cashNote.code } : { kind: "metric", id: "cash" },
    });
  }

  rows.push({
    id: "cashflow",
    label: "Cashflow",
    title: input.cashflow,
    detail: input.cashflowLine,
    open: input.bindingMonth
      ? { kind: "month", key: input.bindingMonth }
      : input.weakMonth
        ? { kind: "month", key: input.weakMonth }
        : undefined,
  });

  rows.push({
    id: "risk",
    label: "Risk",
    title: input.risk,
    detail: input.riskLine,
  });

  // Prefer returns when they hurt eligibility; otherwise keep the capped list focused.
  if (input.bounces > 0 || rows.length < 5) {
    rows.push({
      id: "returns",
      label: "Returns",
      title: input.bounces <= 0 ? "None" : `${input.bounces} in 6 months`,
      detail: input.returnsLine,
      open: { kind: "metric", id: "bounces" },
    });
  }

  return rows.slice(0, 5);
}

function spender(groups: GroupReport) {
  const ranked = KINDS.map((kind) => {
    const rows = groups.spend.filter((group) => kind.groups.includes(group.id));
    const amount = rows.reduce((sum, group) => sum + group.amount, 0);
    const lead = rows.slice().sort((a, b) => b.amount - a.amount)[0];
    return { ...kind, amount, groupId: lead?.id ?? null };
  })
    .filter((kind) => kind.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const lead = ranked[0];
  const next = ranked[1];
  if (!lead) {
    return { id: "unclear", title: "Spender unclear", line: "The outflows are not grouped enough to name a habit.", groupId: null };
  }
  if (next && next.amount * 5 >= lead.amount * 4) {
    return {
      id: "split",
      title: "Split spender",
      line: `${lead.title.replace(" spender", "")} and ${next.title.replace(" spender", "").toLowerCase()} both lead what leaves.`,
      groupId: lead.groupId,
    };
  }
  return { id: lead.id, title: lead.title, line: lead.line, groupId: lead.groupId };
}

function consistency(months: MonthPoint[], bindingMonth: string | null) {
  if (months.length < 2) {
    return {
      tone: "uneven" as const,
      short: false,
      line: "One month cannot show whether this cash repeats.",
      weakMonth: months[0]?.key ?? null,
    };
  }
  const values = months.map((month) => month.cashAfterOps);
  const middle = median(values);
  const off = months.filter((month) => {
    const flipped = middle === 0 ? month.cashAfterOps !== 0 : (month.cashAfterOps >= 0) !== (middle >= 0);
    return flipped || Math.abs(month.cashAfterOps - middle) > Math.abs(middle);
  });
  const weak = months.reduce((best, month) => (month.cashAfterOps < best.cashAfterOps ? month : best));
  const short = middle < 0;
  const focus = bindingMonth ? months.find((month) => month.key === bindingMonth) ?? weak : weak;
  const quiet = bindingMonth
    ? `${focus.label} sizes the facility after cash deposits and self-transfers are stripped, at ${inrCompact(focus.cashAfterOps)}.`
    : `${weak.label} is the weak month, at ${inrCompact(weak.cashAfterOps)}.`;
  if (off.length === 0) {
    return {
      tone: "steady" as const,
      short,
      line: short ? `Every month is short of a new EMI. ${quiet}` : `Every month sits with the middle. ${quiet}`,
      weakMonth: focus.key,
    };
  }
  if (off.length * 2 >= months.length) {
    return {
      tone: "inconsistent" as const,
      short,
      line: `${off.length} of ${months.length} months break from the middle. ${quiet}`,
      weakMonth: focus.key,
    };
  }
  return {
    tone: "uneven" as const,
    short,
    line: `${off.length} of ${months.length} months break from the middle. ${quiet}`,
    weakMonth: focus.key,
  };
}

function riskOf(
  capable: boolean,
  spenderId: string,
  flow: "steady" | "uneven" | "inconsistent",
  bounces: number,
  bounceCap: number,
  obligationRatio: number | null,
  opaqueCash: boolean,
) {
  if (!capable) {
    return { tone: "high" as const, line: "Not eligible: the cash does not repeat into a new EMI." };
  }
  if (bounces > bounceCap) {
    return { tone: "high" as const, line: "Not eligible: returns on the file are above the limit for a new facility." };
  }
  if (obligationRatio != null && obligationRatio >= 0.5) {
    return { tone: "high" as const, line: "Not eligible: existing instalments already take half or more of inflow." };
  }
  if (flow === "inconsistent") {
    return { tone: "high" as const, line: "Eligible with watch: good months and weak months disagree, so a facility has to survive the weak one." };
  }
  if (opaqueCash) {
    return { tone: "watch" as const, line: "Eligible with watch: cash deposits dress the months and are not treated as earned inflow." };
  }
  if (spenderId === "cash") {
    return { tone: "watch" as const, line: "Eligible with watch: cash withdrawals hide where the money goes." };
  }
  if (spenderId === "lifestyle") {
    return { tone: "watch" as const, line: "Eligible with watch: lifestyle spending sits beside any new EMI." };
  }
  if (bounces > 0 || (obligationRatio != null && obligationRatio >= 0.4)) {
    return {
      tone: "watch" as const,
      line:
        bounces > 0
          ? "Eligible with watch: returns are on the file. The facility has to live with that history."
          : "Eligible with watch: fixed debts already claim a large share of inflow.",
    };
  }
  if (flow === "uneven" || spenderId === "debt" || spenderId === "split") {
    return { tone: "watch" as const, line: "Eligible with watch: a few months break the pattern. The facility has to live with the quieter one." };
  }
  return { tone: "contained" as const, line: "Eligible: the same kind of month repeats, and cash is left after it." };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
