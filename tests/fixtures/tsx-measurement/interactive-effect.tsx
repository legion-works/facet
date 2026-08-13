import React, { useEffect, useState } from "react";

export default function ImmediateEffectReport() {
  const [phase, setPhase] = useState("queued");
  useEffect(() => setPhase("ready"), []);
  return (
    <section data-measurement-fixture={`interactive-effect:${phase}`}>
      <h1>Effect delivery report</h1>
      <p>{phase}</p>
    </section>
  );
}
