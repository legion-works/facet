import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

export default function DelayedStructure() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 500);
    return () => clearTimeout(timer);
  }, []);
  return ready ? (
    <section>
      <h1>Ready</h1>
      <ul>
        <li>one</li>
      </ul>
    </section>
  ) : (
    <p>Loading</p>
  );
}

const mount = document.getElementById("facet-tsx-mount");
if (mount !== null) createRoot(mount).render(<DelayedStructure />);
