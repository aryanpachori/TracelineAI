import type { TxnInput } from "./types";

export type ParseResult = {
  rows: TxnInput[];
  skipped: number;
  error?: string;
};

const DATE_HEADERS = ["date", "txn date", "transaction date", "value date", "posted date", "tran date"];
const DESC_HEADERS = ["description", "narration", "particulars", "details", "remarks", "transaction remarks", "narration/particulars"];
const DEBIT_HEADERS = ["debit", "withdrawal", "dr", "withdrawal amt", "withdrawal amount", "amount withdrawn", "debit amount"];
const CREDIT_HEADERS = ["credit", "deposit", "cr", "deposit amt", "deposit amount", "amount deposited", "credit amount"];
const BALANCE_HEADERS = ["balance", "closing balance", "bal", "running balance", "available balance"];
const AMOUNT_HEADERS = ["amount", "txn amount", "transaction amount"];
const TYPE_HEADERS = ["type", "cr/dr", "dr/cr", "transaction type"];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function parseStatement(text: string): ParseResult {
  const table = parseCsv(text.replace(/^\uFEFF/, ""));
  const meaningful = table.filter((row) => row.some((cell) => cell.trim()));
  if (!meaningful.length) {
    return { rows: [], skipped: 0, error: "The file is empty." };
  }

  const headerIndex = meaningful.findIndex((row) => looksLikeHeader(row));
  const header = headerIndex >= 0 ? meaningful[headerIndex].map((cell) => cell.trim().toLowerCase()) : null;
  const body = header ? meaningful.slice(headerIndex + 1) : meaningful;

  const columns = header ? mapColumns(header) : { date: 0, description: 1, debit: 2, credit: 3, balance: 4, amount: -1, type: -1 };

  if (columns.date < 0) {
    return { rows: [], skipped: 0, error: "No date column found. Use Date, Description, Debit, Credit, Balance." };
  }

  const rows: TxnInput[] = [];
  let skipped = 0;

  body.forEach((row) => {
    const date = parseDate(cell(row, columns.date));
    if (!date) {
      if (row.some((value) => value.trim())) skipped += 1;
      return;
    }

    const description = (columns.description >= 0 ? cell(row, columns.description) : "").trim() || "Untitled";
    let debit = 0;
    let credit = 0;

    if (columns.amount >= 0) {
      const amount = parseAmount(cell(row, columns.amount));
      if (Number.isNaN(amount)) {
        skipped += 1;
        return;
      }
      const kind = columns.type >= 0 ? cell(row, columns.type).toLowerCase() : "";
      if (kind.startsWith("d") || kind.includes("debit") || kind.includes("withdrawal")) {
        debit = Math.abs(amount);
      } else if (kind.startsWith("c") || kind.includes("credit") || kind.includes("deposit")) {
        credit = Math.abs(amount);
      } else if (amount < 0) {
        debit = Math.abs(amount);
      } else {
        credit = amount;
      }
    } else {
      debit = columns.debit >= 0 ? parseAmount(cell(row, columns.debit)) : 0;
      credit = columns.credit >= 0 ? parseAmount(cell(row, columns.credit)) : 0;
      if (Number.isNaN(debit) || Number.isNaN(credit)) {
        skipped += 1;
        return;
      }
      if (debit < 0 && credit === 0) {
        credit = Math.abs(debit);
        debit = 0;
      } else if (credit < 0 && debit === 0) {
        debit = Math.abs(credit);
        credit = 0;
      }
      debit = Math.abs(debit);
      credit = Math.abs(credit);
    }

    if (debit === 0 && credit === 0) {
      skipped += 1;
      return;
    }

    const balanceRaw = columns.balance >= 0 ? cell(row, columns.balance) : "";
    const balanceParsed = balanceRaw.trim() ? parseAmount(balanceRaw) : null;

    rows.push({
      date,
      description,
      debit: round2(debit),
      credit: round2(credit),
      balance: balanceParsed == null || Number.isNaN(balanceParsed) ? null : round2(balanceParsed),
    });
  });

  if (!rows.length) {
    return {
      rows: [],
      skipped,
      error: "No transactions could be read. Check that dates are DD-MM-YYYY or YYYY-MM-DD.",
    };
  }

  return { rows, skipped };
}

function looksLikeHeader(row: string[]) {
  const cells = row.map((cell) => cell.trim().toLowerCase());
  return cells.some((cell) => DATE_HEADERS.includes(cell) || cell.includes("date"));
}

function mapColumns(header: string[]) {
  const find = (names: string[]) => header.findIndex((cell) => names.includes(cell) || names.some((name) => cell === name));
  const loose = (needle: string) => header.findIndex((cell) => cell.includes(needle));

  return {
    date: find(DATE_HEADERS) >= 0 ? find(DATE_HEADERS) : loose("date"),
    description: find(DESC_HEADERS) >= 0 ? find(DESC_HEADERS) : loose("narrat"),
    debit: find(DEBIT_HEADERS) >= 0 ? find(DEBIT_HEADERS) : loose("debit") >= 0 ? loose("debit") : loose("withdraw"),
    credit: find(CREDIT_HEADERS) >= 0 ? find(CREDIT_HEADERS) : loose("credit") >= 0 ? loose("credit") : loose("deposit"),
    balance: find(BALANCE_HEADERS) >= 0 ? find(BALANCE_HEADERS) : loose("balance"),
    amount: find(AMOUNT_HEADERS),
    type: find(TYPE_HEADERS),
  };
}

function cell(row: string[], index: number) {
  if (index < 0) return "";
  return row[index] ?? "";
}

export function parseDate(raw: string): string | null {
  const value = raw.trim().replace(/\./g, "/");
  if (!value) return null;

  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const named = /^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{2,4})/.exec(value);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    let year = Number(named[3]);
    if (year < 100) year += 2000;
    if (!month) return null;
    return toIso(year, month, Number(named[1]));
  }

  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/.exec(value);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    return toIso(year, Number(dmy[2]), Number(dmy[1]));
  }

  return null;
}

function toIso(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseAmount(raw: string) {
  let value = raw.trim();
  if (!value || value === "-" || value === "—" || value === "–") return 0;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  if (/dr$/i.test(value)) negative = true;
  value = value.replace(/₹|rs\.?|inr/gi, "").replace(/,/g, "").replace(/\s|cr$|dr$/gi, "").trim();
  if (!value) return 0;
  const amount = Number(value);
  if (Number.isNaN(amount)) return Number.NaN;
  return negative ? -Math.abs(amount) : amount;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function parseCsv(text: string): string[][] {
  const sample = text.split(/\r?\n/).slice(0, 6).join("\n");
  const commas = sample.split(",").length;
  const semis = sample.split(";").length;
  const tabs = sample.split("\t").length;
  const delim = tabs > commas && tabs > semis ? "\t" : semis > commas ? ";" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delim) {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char !== "\r") field += char;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
