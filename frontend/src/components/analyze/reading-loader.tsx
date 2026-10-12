"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

const STEPS = ["Reading the file", "Grouping each row", "Sizing the facility"];

export function ReadingLoader({ fileName }: { fileName?: string }) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const clock = window.setInterval(() => setElapsed((current) => current + 1), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (reduce) return;
    const timer = window.setInterval(() => {
      setStep((current) => Math.min(current + 1, STEPS.length - 1));
    }, 2800);
    return () => window.clearInterval(timer);
  }, [reduce]);

  return (
    <div className="reader" role="status" aria-live="polite">
      <div className="reader-mark" aria-hidden="true" />
      <p className="font-serif text-3xl font-normal leading-tight">Reading the statement</p>
      {fileName ? <p className="mt-1 text-sm text-muted">{fileName}</p> : null}
      <ol className="mt-5 space-y-2 text-sm">
        {STEPS.map((label, index) => {
          const done = index < step;
          const current = index === step;
          return (
            <li key={label} className={current ? "font-semibold text-pine" : done ? "text-ink" : "text-muted"}>
              {label}
              {current ? "…" : done ? "" : ""}
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-sm text-muted">{elapsed}s · a long statement stays here until the reader finishes</p>
      <div className="reader-bar mt-5" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}
