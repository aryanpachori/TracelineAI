import { Suspense } from "react";
import { AnalyzeApp } from "@/components/analyze/analyze-app";

export default function AnalyzePage() {
  return (
    <Suspense fallback={null}>
      <AnalyzeApp />
    </Suspense>
  );
}
