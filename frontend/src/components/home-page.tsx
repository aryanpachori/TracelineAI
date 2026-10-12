import Link from "next/link";
import { DownloadSample } from "@/components/download-sample";
import { SiteHeader } from "@/components/site-header";
import { inrCompact, pct } from "@/lib/format";
import type { Preview } from "@/lib/types";

export function HomePage({ preview }: { preview: Preview }) {
  return (
    <div>
      <SiteHeader />
      <main className="mx-auto max-w-[1080px] px-5">
        <section className="grid items-end gap-10 py-14 lg:grid-cols-12 lg:py-20">
          <div className="lg:col-span-7">
            <h1 className="max-w-[18ch] font-serif text-[2.7rem] font-normal leading-[1.08] tracking-[-0.02em] sm:text-6xl">
              AI credit analyzer for NBFCs.
            </h1>
            <p className="mt-6 max-w-[42rem] text-[1.125rem] leading-7 text-ink">
              Traceline reads a bank statement for NBFCs lending to thin-file businesses. AI
              groups every credit and debit, charts cash flow and spending, and sizes the
              facility the account can carry, down to the merchant and the row.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/analyze" className="on-ink px-4 py-2.5">
                Analyze a statement
              </Link>
              <Link href="/analyze?sample=1" className="rounded-xl border border-rule bg-white px-4 py-2.5">
                Open the sample file
              </Link>
              <DownloadSample />
            </div>
          </div>

          <aside className="panel lg:col-span-5">
            <div className="flex items-baseline justify-between gap-3 border-b border-rule px-4 py-3 text-sm">
              <span>Case MEERA-TEXTILES</span>
              <span className="text-muted">Sample · standard terms</span>
            </div>
            <div className="px-4 py-4">
              <p className="text-sm text-muted">{preview.period}</p>
              <div className="mt-3 flex items-end gap-4">
                <p className="font-serif text-7xl leading-none">{preview.grade}</p>
                <div className="pb-1">
                  <p className="text-2xl font-semibold tracking-[-0.03em] text-pine">{preview.gradeLabel}</p>
                  <p className="text-sm text-muted">Readiness {preview.points}</p>
                </div>
              </div>
              <p className="mt-5 text-sm text-muted">Facility</p>
              <p className="num font-serif text-3xl leading-tight">
                {inrCompact(preview.bandLow)} – {inrCompact(preview.bandHigh)}
              </p>
              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-rule pt-4 text-sm">
                <div>
                  <dt className="text-muted">Earned inflow</dt>
                  <dd className="num">{inrCompact(preview.avgInflow)} / mo</dd>
                </div>
                <div>
                  <dt className="text-muted">Cash after operations</dt>
                  <dd className="num">{inrCompact(preview.cashAfterOps)} / mo</dd>
                </div>
                <div>
                  <dt className="text-muted">EMI + rent</dt>
                  <dd className="num">{pct(preview.obligationRatio)} of inflow</dd>
                </div>
                <div>
                  <dt className="text-muted">Returns, last 6 months</dt>
                  <dd className="num">{preview.bounces}</dd>
                </div>
              </dl>
              <p className="mt-4 text-sm leading-5 text-muted">
                {preview.topName} is {pct(preview.topShare)} of business receipts. AI grouped the
                EMIs, autopays, and mobile payments on this account.
              </p>
              <Link href="/analyze?sample=1" className="mt-4 inline-block text-sm underline decoration-rule underline-offset-4">
                Open this statement
              </Link>
            </div>
          </aside>
        </section>

        <section className="border-t border-rule py-12">
          <h2 className="max-w-[20ch] font-serif text-4xl font-normal leading-tight">
            Bureau files are built to reject this borrower.
          </h2>
          <div className="mt-8 grid gap-8 md:grid-cols-3">
            <p>
              <span className="font-medium">Thin files. </span>
              A self-employed borrower often has little bureau history and no collateral. The
              useful record is already in the account: who paid, what bounced, and what is
              already committed each month.
            </p>
            <p>
              <span className="font-medium">Mixed money. </span>
              UPI receipts, a loan disbursement, and a transfer from savings sit on the same
              statement. Counting all of it as income is how a good file and a weak one get
              the same answer.
            </p>
            <p>
              <span className="font-medium">One file. </span>
              The month, the commitment, and the statement row sit on the same screen. Open any
              figure and the rows behind it come into view.
            </p>
          </div>
        </section>

        <section id="file" className="border-t border-rule py-12">
          <h2 className="font-serif text-4xl font-normal">What the file contains</h2>
          <table className="sheet-table mt-6">
            <thead>
              <tr>
                <th className="w-[34%]">Line</th>
                <th>How it is made</th>
              </tr>
            </thead>
            <tbody>
              {FILE_ROWS.map((row) => (
                <tr key={row.line}>
                  <td className="font-medium">{row.line}</td>
                  <td>{row.how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section id="method" className="border-t border-rule py-12">
          <h2 className="font-serif text-4xl font-normal">How a case moves</h2>
          <ol className="mt-6">
            {STEPS.map((step, index) => (
              <li key={step.title} className="grid grid-cols-[2.5rem_1fr] gap-3 border-t border-rule py-4">
                <span className="num text-muted">{index + 1}</span>
                <p>
                  <span className="font-medium">{step.title}. </span>
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section id="who" className="border-t border-rule py-12">
          <h2 className="font-serif text-4xl font-normal">Who it is for</h2>
          <dl className="mt-6">
            {PEOPLE.map((person) => (
              <div key={person.role} className="grid gap-1 border-t border-rule py-4 md:grid-cols-[14rem_1fr]">
                <dt className="font-medium">{person.role}</dt>
                <dd>{person.job}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 max-w-[40rem] text-muted">
            Built for credit teams and for the person whose account it is. The statement is the input, and the picture opens on this screen.
          </p>
        </section>

        <section className="border-t border-rule py-14">
          <p className="max-w-[28ch] font-serif text-4xl leading-tight">
            Open a statement. The sample is a textile account, twelve months long.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/analyze?sample=1" className="on-ink px-4 py-2.5">
              Open the sample file
            </Link>
            <Link href="/analyze" className="rounded-xl border border-rule bg-white px-4 py-2.5">
              Use your own CSV
            </Link>
          </div>
        </section>
      </main>
      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-[1080px] flex-wrap items-baseline justify-between gap-3 px-5 py-5 text-sm text-muted">
          <p>Traceline reads the whole account for credit teams and for the account holder.</p>
          <p>Every figure opens to the rows behind it.</p>
        </div>
      </footer>
    </div>
  );
}

const FILE_ROWS = [
  {
    line: "The whole account",
    how: "Every credit and debit stays in the file. AI splits them into income and spending groups, then into merchants and statement rows.",
  },
  {
    line: "Earned inflow",
    how: "Business receipts and salary, after returned cheques. Loan credits, self-transfers, and cash deposits stay out.",
  },
  {
    line: "Cash after operations",
    how: "Earned inflow minus EMI, rent, suppliers, utilities, tax, and bounce charges. Personal drawings are shown, and are not treated as debt service.",
  },
  {
    line: "Repayment capacity",
    how: "A share of cash left in a typical month. The share, the rate, and the tenure can be moved on the file.",
  },
  {
    line: "Facility",
    how: "The loan that capacity would carry, with a type, an amount range, and a rate range.",
  },
  {
    line: "Notes",
    how: "Each attention or watch item opens onto the statement rows that produced it.",
  },
  {
    line: "Readiness",
    how: "A grade from the cash-flow picture, from 100 downward as returns, concentration, and thin months appear.",
  },
];

const STEPS = [
  {
    title: "Bring the statement",
    body: "A CSV with date, description, debit, credit, and balance.",
  },
  {
    title: "Let AI group the narrations",
    body: "Suppliers, EMIs, rent, food, fuel, subscriptions, insurance, cash, and every other credit and debit on the statement.",
  },
  {
    title: "Measure the months",
    body: "Inflow, cash left, volatility, and returns. The facility, the amount, and the rate are calculated from those groups.",
  },
  {
    title: "Set the terms",
    body: "Obligation share, return limit, concentration, rate, and tenure. Move one and the facility is recalculated.",
  },
  {
    title: "Open the rows",
    body: "Every group, merchant, month, and commitment opens to the statement lines behind it.",
  },
];

const PEOPLE = [
  {
    role: "Credit or risk head",
    job: "Wants each file to open cleanly, and wants the terms visible when a number moves.",
  },
  {
    role: "Credit analyst",
    job: "Wants the month, the flags, and the statement rows in one sitting.",
  },
  {
    role: "Product head",
    job: "Wants a way to look at thin-file applicants without pretending the bureau is enough.",
  },
  {
    role: "The account holder",
    job: "Wants a clear picture of where money comes from and where it goes, down to the merchant.",
  },
];
