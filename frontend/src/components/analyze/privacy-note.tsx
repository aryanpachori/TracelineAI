"use client";

import { useState } from "react";

const STORAGE_KEY = "traceline-desk-v1";

export function PrivacyNote() {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string[] | null>(null);

  function showProof() {
    const keys = Object.keys(window.localStorage);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    let desk = "Nothing from this screen is saved yet.";
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const fields = Object.keys(parsed);
        const hasRows = /description|debit|credit|narration/i.test(raw);
        desk = hasRows
          ? "The saved item includes statement text. That should not happen."
          : `Saved fields: ${fields.join(", ") || "none"}. No narrations, amounts, or dates.`;
      } catch {
        desk = "The saved item could not be read.";
      }
    }
    setSaved([desk, keys.length ? `Browser keys on this site: ${keys.join(", ")}` : "This site has no saved keys."]);
    setOpen(true);
  }

  return (
    <div className="mt-6 rounded-2xl border border-rule bg-white px-4 py-4">
      <p className="font-medium">The statement is not saved with us.</p>
      <p className="mt-1 max-w-[40rem] text-sm text-muted">
        It is read in this browser and stays in the tab. Closing the tab or choosing New statement clears it. Traceline does not receive the file.
      </p>
      <button type="button" className="mt-3 text-sm font-semibold text-pine underline underline-offset-4" onClick={showProof}>
        {open ? "Refresh the check" : "Show what this browser saved"}
      </button>
      {open && saved ? (
        <ul className="mt-3 space-y-1 text-sm">
          {saved.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li className="text-muted">
            Outside proof: open the browser Network tab, then load a statement. The file should not appear in any request.
          </li>
        </ul>
      ) : null}
    </div>
  );
}
