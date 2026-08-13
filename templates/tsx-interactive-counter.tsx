import React, { useState } from "react";

/**
 * Publish with `--execution interactive` to enable the handler below.
 * Facet mounts this default export; templates never call createRoot themselves.
 */
export default function InteractiveCounter() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>Interactive counter</h1>
      <p>Button presses: {count}</p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
    </main>
  );
}
