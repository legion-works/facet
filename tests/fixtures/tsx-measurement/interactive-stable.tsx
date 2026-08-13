import React, { useState } from "react";

export default function StableInteractiveReport() {
  const [title] = useState("Stable release report");
  return (
    <section data-measurement-fixture="interactive-stable">
      <h1>{title}</h1>
      <p>State is initialized without changing the observed structure.</p>
    </section>
  );
}
