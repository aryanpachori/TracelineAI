import { CATEGORY_LABEL, inr } from "./format";
import { railOf } from "./flows";
import type { Analysis, SeriesKind, Txn } from "./types";

const SERIES_LABEL: Record<SeriesKind, string> = {
  emi: "EMI mandate",
  autopay: "Autopay",
  subscription: "Subscription",
  standing: "Standing payment",
  repeat: "Repeats each month",
};

export function explainTxn(analysis: Analysis, txn: Txn) {
  const group = [...analysis.groups.spend, ...analysis.groups.income].find((item) => item.txnIds.includes(txn.id));
  const series = analysis.flows.series.find((item) => item.txnIds.includes(txn.id));
  const rail = railOf(txn.description);
  const party = txn.counterparty && txn.counterparty !== "Unknown" ? txn.counterparty : "this name";
  const amount = inr(txn.debit || txn.credit, 0);
  const direction = txn.debit > 0 ? "out" : "in";
  const tags = [
    group?.name,
    CATEGORY_LABEL[txn.category],
    rail,
    direction === "out" ? "Money out" : "Money in",
    series ? SERIES_LABEL[series.kind] : null,
  ].filter((tag): tag is string => Boolean(tag));

  return {
    party,
    rail,
    amount,
    direction,
    group,
    series,
    tags,
    purpose: purposeLine(txn, group?.id, party, rail, amount, series?.kind),
  };
}

function purposeLine(
  txn: Txn,
  groupId: string | undefined,
  party: string,
  rail: string,
  amount: string,
  seriesKind?: SeriesKind,
) {
  const via = rail === "Other" ? "" : ` on ${rail}`;
  const repeat = seriesKind ? ` It posts again across the statement as a ${SERIES_LABEL[seriesKind].toLowerCase()}.` : "";
  switch (groupId) {
    case "suppliers":
      return `${amount} to ${party}${via} for supplies or stock. AI tags this as a business cost and takes it out of cash left.`;
    case "emi":
      return `${amount} loan EMI to ${party}${via}. This is a repayment already leaving the account.${repeat}`;
    case "rent":
      return `${amount} rent to ${party}${via}. AI treats this as a fixed commitment.${repeat}`;
    case "food":
      return `${amount} to ${party}${via} for food and groceries. This is personal spending, shown on the file and kept apart from business costs.`;
    case "fuel":
      return `${amount} to ${party}${via} for fuel. Personal running cost, not a supplier payment.`;
    case "healthcare":
      return `${amount} to ${party}${via} for healthcare.`;
    case "shopping":
      return `${amount} to ${party}${via} for shopping.`;
    case "subscriptions":
      return `${amount} to ${party}${via} for a subscription.${repeat}`;
    case "insurance":
      return `${amount} to ${party}${via} for insurance.${repeat}`;
    case "utilities":
      return `${amount} to ${party} for utilities. Taken out with operating costs.`;
    case "tax":
      return `${amount} tax payment${party === "this name" ? "" : ` to ${party}`}. Taken out with operating costs.`;
    case "cash":
      return `${amount} withdrawn as cash. Drawings, not a business payment.`;
    case "self":
    case "self_in":
      return `${amount} moved ${groupId === "self" ? "to" : "from"} the same person's own account. Kept out of business income.`;
    case "returns":
      return `${amount} returned cheque${party === "this name" ? "" : ` from ${party}`}. The receipt is taken back out of earned income.`;
    case "charges":
      return `${amount} bank charge on a returned instrument.`;
    case "business":
      return `${amount} received from ${party}${via}. AI counts this as a business receipt.`;
    case "salary":
      return `${amount} salary credit${via}. Counted as earned income.`;
    case "loan":
      return `${amount} loan credit${party === "this name" ? "" : ` from ${party}`}. Money borrowed, not income from customers.`;
    case "cash_in":
      return `${amount} cash deposited at the branch. Visible on the file and kept out of earned income.`;
    case "transfer_in":
      return `${amount} transferred in from ${party}. Not treated as a customer receipt.`;
    default:
      return txn.debit > 0
        ? `${amount} left the account${party === "this name" ? "" : ` to ${party}`}${via}.`
        : `${amount} came into the account${party === "this name" ? "" : ` from ${party}`}${via}.`;
  }
}
