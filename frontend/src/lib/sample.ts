const BUYERS = [
  { name: "SHAH WHOLESALE", weight: 0.44, rail: "NEFT" },
  { name: "PATEL FABRICS", weight: 0.16, rail: "NEFT" },
  { name: "CITY MART TEXTILES", weight: 0.14, rail: "RTGS" },
  { name: "MEENA BOUTIQUE", weight: 0.1, rail: "IMPS" },
  { name: "RITA COLLECTIONS", weight: 0.09, rail: "UPI" },
  { name: "NOOR GARMENTS", weight: 0.07, rail: "UPI" },
] as const;

const MONTHS: { ym: string; earned: number; power: number }[] = [
  { ym: "2025-10", earned: 168000, power: 3800 },
  { ym: "2025-11", earned: 182000, power: 4100 },
  { ym: "2025-12", earned: 246000, power: 5400 },
  { ym: "2026-01", earned: 121000, power: 3600 },
  { ym: "2026-02", earned: 154000, power: 3900 },
  { ym: "2026-03", earned: 176000, power: 4300 },
  { ym: "2026-04", earned: 189000, power: 4700 },
  { ym: "2026-05", earned: 171000, power: 5100 },
  { ym: "2026-06", earned: 148000, power: 6200 },
  { ym: "2026-07", earned: 163000, power: 5800 },
  { ym: "2026-08", earned: 198000, power: 4900 },
  { ym: "2026-09", earned: 184000, power: 4500 },
];

const BUYER_DAYS = [3, 8, 12, 17, 22, 26];

type Stamped = {
  ym: string;
  day: number;
  description: string;
  debit: number;
  credit: number;
};

export const SAMPLE_CASE = {
  reference: "MEERA-TEXTILES",
  fileName: "meera-textiles-current-account.csv",
  account: "Meera Textiles · current account",
};

export function sampleCsv() {
  const rows: Stamped[] = [];

  MONTHS.forEach((month, index) => {
    const shares = split(month.earned, BUYERS.map((buyer) => buyer.weight));
    BUYERS.forEach((buyer, buyerIndex) => {
      const description =
        buyer.rail === "UPI"
          ? `UPI/${buyer.name}/OKSBI`
          : `${buyer.rail}/${buyer.name}/N${1000 + index}${buyerIndex}`;
      rows.push({
        ym: month.ym,
        day: BUYER_DAYS[buyerIndex],
        description,
        debit: 0,
        credit: shares[buyerIndex],
      });
    });

    const supplierTotal = Math.round(month.earned * 0.38);
    const mills = Math.round(supplierTotal * 0.62);
    rows.push(
      { ym: month.ym, day: 1, description: "NEFT/RENT/LANDLORD SHARMA", debit: 12000, credit: 0 },
      { ym: month.ym, day: 2, description: "UPI/NETFLIX/AUTOPAY", debit: 649, credit: 0 },
      { ym: month.ym, day: 5, description: "NACH/HDFC BANK/EMI LOAN XX9021", debit: 18000, credit: 0 },
      { ym: month.ym, day: 7, description: "NACH/LIC OF INDIA/INSURANCE MANDATE", debit: 2450, credit: 0 },
      { ym: month.ym, day: 15, description: "UPI/GOOGLE WORKSPACE", debit: 1360, credit: 0 },
      { ym: month.ym, day: 11, description: "NEFT/RAJESH MILLS/PURCHASE", debit: mills, credit: 0 },
      { ym: month.ym, day: 19, description: "IMPS/SURAT DYE HOUSE/PURCHASE", debit: supplierTotal - mills, credit: 0 },
      { ym: month.ym, day: 8, description: "BESCOM ELECTRICITY BILL", debit: month.power, credit: 0 },
      { ym: month.ym, day: 16, description: "UPI/SWIGGY", debit: 640, credit: 0 },
      { ym: month.ym, day: 12, description: "UPI/APOLLO PHARMACY", debit: 890, credit: 0 },
      { ym: month.ym, day: 18, description: "UPI/AMAZON PAY", debit: 2140, credit: 0 },
      { ym: month.ym, day: 23, description: "UPI/HPCL PETROL", debit: 1850, credit: 0 },
      { ym: month.ym, day: 26, description: "UPI/BIGBASKET", debit: 1560, credit: 0 },
    );
    if (index % 2 === 0) {
      rows.push({ ym: month.ym, day: 21, description: "ATM CASH WDL", debit: 4000, credit: 0 });
    }
  });

  rows.push(
    { ym: "2026-07", day: 18, description: "CLG/CITY MART TEXTILES/CHQ 7712", debit: 0, credit: 22000 },
    { ym: "2026-07", day: 20, description: "CHQ RETURN/CITY MART TEXTILES/INSUFFICIENT FUNDS", debit: 22000, credit: 0 },
    { ym: "2026-07", day: 20, description: "CHQ RETURN CHARGES", debit: 295, credit: 0 },
    { ym: "2026-08", day: 9, description: "CLG/PATEL FABRICS/CHQ 458721", debit: 0, credit: 48000 },
    { ym: "2026-08", day: 14, description: "CHQ RETURN/PATEL FABRICS/INSUFFICIENT FUNDS", debit: 48000, credit: 0 },
    { ym: "2026-08", day: 14, description: "CHQ RETURN CHARGES", debit: 590, credit: 0 },
    { ym: "2025-12", day: 18, description: "NEFT/TERM LOAN DISBURSEMENT HDFC", debit: 0, credit: 150000 },
    { ym: "2025-12", day: 28, description: "GST CHALLAN CBDT", debit: 16500, credit: 0 },
    { ym: "2026-03", day: 4, description: "NEFT/SELF TRF FROM SAVINGS XX4412", debit: 0, credit: 45000 },
    { ym: "2026-03", day: 20, description: "NEFT/SELF TRF TO SAVINGS XX4412", debit: 12000, credit: 0 },
    { ym: "2026-03", day: 28, description: "GST CHALLAN CBDT", debit: 15200, credit: 0 },
    { ym: "2026-05", day: 13, description: "IMPS/TRANSFER FROM RAVI", debit: 0, credit: 20000 },
    { ym: "2026-06", day: 20, description: "NEFT/SELF TRF TO SAVINGS XX4412", debit: 12000, credit: 0 },
    { ym: "2026-06", day: 28, description: "GST CHALLAN CBDT", debit: 14800, credit: 0 },
    { ym: "2026-09", day: 20, description: "NEFT/SELF TRF TO SAVINGS XX4412", debit: 12000, credit: 0 },
    { ym: "2026-09", day: 28, description: "GST CHALLAN CBDT", debit: 17100, credit: 0 },
    { ym: "2025-10", day: 6, description: "CASH DEPOSIT BRANCH", debit: 0, credit: 12000 },
    { ym: "2026-02", day: 6, description: "CASH DEPOSIT BRANCH", debit: 0, credit: 8000 },
    { ym: "2026-08", day: 6, description: "CASH DEPOSIT BRANCH", debit: 0, credit: 15000 },
  );

  const ordered = [...rows].sort((a, b) => {
    if (a.ym !== b.ym) return a.ym < b.ym ? -1 : 1;
    if (a.day !== b.day) return a.day - b.day;
    if (a.credit !== b.credit) return b.credit - a.credit;
    return a.description.localeCompare(b.description);
  });

  let balance = 92450;
  const csv = ["Date,Description,Debit,Credit,Balance"];
  ordered.forEach((row) => {
    balance = Math.round((balance + row.credit - row.debit) * 100) / 100;
    const [year, month] = row.ym.split("-");
    const date = `${String(row.day).padStart(2, "0")}-${month}-${year}`;
    csv.push(
      [
        date,
        csvEscape(row.description),
        row.debit ? String(row.debit) : "",
        row.credit ? String(row.credit) : "",
        String(balance),
      ].join(","),
    );
  });
  return csv.join("\n");
}

function split(total: number, weights: number[]) {
  const raw = weights.map((weight) => Math.round(total * weight));
  raw[0] += total - raw.reduce((sum, value) => sum + value, 0);
  return raw;
}

function csvEscape(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
