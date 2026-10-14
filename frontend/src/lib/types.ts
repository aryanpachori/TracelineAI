export type Category =
  | "business_in"
  | "salary"
  | "transfer_in"
  | "loan_in"
  | "self_in"
  | "cash_in"
  | "emi"
  | "rent"
  | "supplier"
  | "utilities"
  | "tax"
  | "bounce_reversal"
  | "bounce_charge"
  | "cash_out"
  | "personal"
  | "self_out"
  | "transfer_out"
  | "other_in"
  | "other_out";

export type TxnInput = {
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number | null;
  category?: Category;
};

export type AiReading = {
  letter: "A" | "B" | "C" | "D" | "E";
  points: number;
  label: string;
  summary: string;
  rates: {
    business: [number, number];
  };
};

export type Txn = TxnInput & {
  id: string;
  category: Category;
  counterparty: string;
};

export type Policy = {
  maxObligationRatio: number;
  maxBounces6m: number;
  minMonths: number;
  maxConcentration: number;
  surplusShare: number;
  annualRate: number;
  tenureMonths: number;
  minAvgInflow: number;
};

export type MonthPoint = {
  key: string;
  label: string;
  earned: number;
  businessCredits: number;
  cashIn: number;
  loanIn: number;
  selfAndTransferIn: number;
  otherIn: number;
  reversals: number;
  emi: number;
  rent: number;
  suppliers: number;
  utilitiesTax: number;
  bounceCount: number;
  bounceCharges: number;
  drawings: number;
  obligations: number;
  operating: number;
  surplusAfterObligations: number;
  cashAfterOps: number;
  totalIn: number;
  totalOut: number;
};

export type Reason = {
  code: string;
  title: string;
  detail: string;
  severity: "good" | "info" | "watch" | "breach";
  txnIds: string[];
};

export type RuleHit = {
  id: string;
  label: string;
  delta: number;
  hit: boolean;
  note: string;
};

export type IntegrityCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "na";
  detail: string;
};

export type Counterparty = {
  name: string;
  amount: number;
  share: number;
  count: number;
};

export type Analysis = {
  txns: Txn[];
  months: MonthPoint[];
  periodLabel: string;
  start: string;
  end: string;
  metrics: {
    months: number;
    avgEarned: number;
    medianEarned: number;
    medianSurplus: number;
    medianCashAfterOps: number;
    obligationRatio: number;
    volatility: number;
    bounces6m: number;
    bounceCharges: number;
    topShare: number;
    topName: string;
    nonEarnedShare: number;
    trend: number;
    drawingsAvg: number;
    totalEarned: number;
    totalCredits: number;
  };
  capacity: {
    monthly: number;
    principal: number;
    bandLow: number;
    bandHigh: number;
    basis: string;
  };
  payability: {
    mode: "formal" | "cashflow";
    workIn: number;
    workAvg: number;
    spent: number;
    spentAvg: number;
    left: number;
    moved: number;
  };
  grade: {
    letter: "A" | "B" | "C" | "D" | "E";
    points: number;
    label: string;
    rules: RuleHit[];
  };
  reasons: Reason[];
  integrity: IntegrityCheck[];
  counterparties: Counterparty[];
  outflowMix: { key: string; label: string; amount: number }[];
  summary: string;
  dataConfidence: number;
  uncategorizedShare: number;
  flows: FlowReport;
  groups: GroupReport;
};

export type Preview = {
  grade: Analysis["grade"]["letter"];
  gradeLabel: string;
  points: number;
  capacity: number;
  bandLow: number;
  bandHigh: number;
  avgInflow: number;
  cashAfterOps: number;
  bounces: number;
  obligationRatio: number;
  period: string;
  summary: string;
  topName: string;
  topShare: number;
};

export type SeriesKind = "emi" | "autopay" | "subscription" | "standing" | "repeat";

export type RecurringSeries = {
  id: string;
  name: string;
  kind: SeriesKind;
  rail: string;
  typical: number;
  monthsSeen: number;
  monthsSpan: number;
  missed: number;
  lastDate: string;
  bounced: boolean;
  txnIds: string[];
};

export type RailMix = {
  rail: string;
  inflow: number;
  outflow: number;
  inCount: number;
  outCount: number;
};

export type MonthPattern = {
  key: string;
  label: string;
  inflow: number;
  outflow: number;
  upiIn: number;
  upiOut: number;
  emi: number;
  autopay: number;
  subscription: number;
};

export type FacilityFit = "strong" | "conditional" | "weak";

export type Facility = {
  id: string;
  name: string;
  fit: FacilityFit;
  amountLow: number;
  amountHigh: number;
  rateLow: number;
  rateHigh: number;
  tenure: string;
  why: string;
  reading: string;
};

export type FlowReport = {
  series: RecurringSeries[];
  rails: RailMix[];
  months: MonthPattern[];
  facilities: Facility[];
  upiShare: number;
  extraCommit: number;
  reading: string;
};

export type MoneyGroup = {
  id: string;
  name: string;
  side: "in" | "out";
  color: string;
  amount: number;
  count: number;
  share: number;
  txnIds: string[];
  merchants: { name: string; amount: number; count: number; txnIds: string[] }[];
};

export type GroupMonth = {
  key: string;
  label: string;
  values: Record<string, number>;
};

export type GroupReport = {
  reading: string;
  spend: MoneyGroup[];
  income: MoneyGroup[];
  months: GroupMonth[];
  chartIds: string[];
};

export type WidgetId =
  | "verdict"
  | "kpis"
  | "spending"
  | "facilities"
  | "flows"
  | "cashflow"
  | "composition"
  | "outflows"
  | "counterparties"
  | "flags"
  | "policy"
  | "readiness"
  | "integrity"
  | "monthly"
  | "ledger";

export type ChartType = "area" | "bar" | "line";

export type ChartSeriesKey = "earned" | "cashAfterOps" | "obligations" | "totalIn";

export type ChartConfig = {
  type: ChartType;
  series: Record<ChartSeriesKey, boolean>;
};

export type WidgetSetting = {
  id: WidgetId;
  visible: boolean;
};
