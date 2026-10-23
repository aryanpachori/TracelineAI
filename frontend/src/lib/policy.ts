import type { ChartConfig, Policy, WidgetId, WidgetSetting } from "./types";

export const STANDARD_POLICY: Policy = {
  maxObligationRatio: 0.4,
  maxBounces6m: 1,
  minMonths: 6,
  maxConcentration: 0.6,
  surplusShare: 0.35,
  annualRate: 0.24,
  tenureMonths: 18,
  minAvgInflow: 100000,
};

export const POLICY_PRESETS: { id: string; label: string; hint: string; policy: Policy }[] = [
  {
    id: "micro",
    label: "Micro (3 months)",
    hint: "Short vintage, tighter FOIR, small unsecured ticket",
    policy: {
      maxObligationRatio: 0.35,
      maxBounces6m: 0,
      minMonths: 3,
      maxConcentration: 0.55,
      surplusShare: 0.25,
      annualRate: 0.32,
      tenureMonths: 6,
      minAvgInflow: 40000,
    },
  },
  {
    id: "personal",
    label: "Personal loan (6 months)",
    hint: "Salaried or mixed file, standard FOIR and bounce cap",
    policy: STANDARD_POLICY,
  },
  {
    id: "msme",
    label: "MSME (12 months)",
    hint: "Trader file, longer vintage, FOIR on earned receipts",
    policy: {
      maxObligationRatio: 0.5,
      maxBounces6m: 1,
      minMonths: 12,
      maxConcentration: 0.65,
      surplusShare: 0.35,
      annualRate: 0.22,
      tenureMonths: 24,
      minAvgInflow: 100000,
    },
  },
  {
    id: "conservative",
    label: "Conservative",
    hint: "Tighter bounces, shorter tenure, smaller share of surplus",
    policy: {
      maxObligationRatio: 0.3,
      maxBounces6m: 0,
      minMonths: 12,
      maxConcentration: 0.45,
      surplusShare: 0.2,
      annualRate: 0.28,
      tenureMonths: 12,
      minAvgInflow: 150000,
    },
  },
];

export const WIDGET_META: Record<WidgetId, { title: string; span: string }> = {
  verdict: { title: "Repayment view", span: "lg:col-span-12" },
  kpis: { title: "Averages", span: "lg:col-span-12" },
  spending: { title: "Where the money goes", span: "lg:col-span-12" },
  facilities: { title: "Offer", span: "lg:col-span-12" },
  flows: { title: "Recurring flows", span: "lg:col-span-12" },
  cashflow: { title: "Cash flow", span: "lg:col-span-6" },
  composition: { title: "Credits", span: "lg:col-span-6" },
  outflows: { title: "Debits", span: "lg:col-span-6" },
  counterparties: { title: "Payers", span: "lg:col-span-6" },
  flags: { title: "Notes", span: "lg:col-span-6" },
  policy: { title: "Terms", span: "lg:col-span-6" },
  readiness: { title: "What moved the readiness", span: "lg:col-span-12" },
  integrity: { title: "Statement checks", span: "lg:col-span-12" },
  monthly: { title: "Monthly figures", span: "lg:col-span-12" },
  ledger: { title: "Rows", span: "lg:col-span-12" },
};

export const DEFAULT_WIDGETS: WidgetSetting[] = [
  { id: "verdict", visible: true },
  { id: "kpis", visible: true },
  { id: "spending", visible: true },
  { id: "facilities", visible: true },
  { id: "flows", visible: true },
  { id: "cashflow", visible: true },
  { id: "composition", visible: true },
  { id: "outflows", visible: true },
  { id: "counterparties", visible: true },
  { id: "flags", visible: true },
  { id: "policy", visible: true },
  { id: "readiness", visible: true },
  { id: "integrity", visible: true },
  { id: "monthly", visible: true },
  { id: "ledger", visible: true },
];

export const DEFAULT_CHART: ChartConfig = {
  type: "area",
  series: {
    earned: true,
    cashAfterOps: true,
    obligations: true,
    totalIn: false,
  },
};

export const SERIES_META: Record<keyof ChartConfig["series"], { label: string; color: string }> = {
  earned: { label: "Earned inflow", color: "#0c9a74" },
  cashAfterOps: { label: "Cash after operations", color: "#2563eb" },
  obligations: { label: "EMI + rent", color: "#d97706" },
  totalIn: { label: "All credits", color: "#94a3b8" },
};
