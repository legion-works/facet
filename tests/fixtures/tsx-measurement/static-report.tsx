import React from "react";

export default function ReleaseReport({
  title = "Verification report",
}: {
  readonly title?: string;
}) {
  return (
    <section data-measurement-fixture="static-report">
      <h1>{title}</h1>
      <p>Compiler output is retained with the published revision.</p>
    </section>
  );
}
