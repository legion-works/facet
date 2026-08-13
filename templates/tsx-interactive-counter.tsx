import React, { useState } from "react";

export default function InteractiveCounter() {
  const [count, setCount] = useState(0);

  return (
    <section className="card bg-legion-paper p-6 w-full max-w-prose">
      <h1 className="text-2xl font-semibold text-legion-ink">Interactive counter</h1>
      <p className="text-legion-muted mt-2">Button presses: {count}</p>
      <button
        type="button"
        className="btn bg-legion-cyan text-legion-ink mt-4 px-4 py-2 rounded"
        onClick={() => setCount((value) => value + 1)}
      >
        Increment
      </button>
    </section>
  );
}
