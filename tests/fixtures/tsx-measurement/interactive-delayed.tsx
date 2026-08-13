import React, { useEffect, useState } from "react";

export default function DelayedReport() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 600);
    return () => clearTimeout(timer);
  }, []);
  return (
    <section data-measurement-fixture="interactive-delayed">
      <h1>Measured delivery report</h1>
      {ready ? (
        <ul>
          <li>Stable window observed the update</li>
        </ul>
      ) : (
        <p>Awaiting measured delivery</p>
      )}
    </section>
  );
}
