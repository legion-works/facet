import React, { useState } from "react";

export default function Counter({ initial }: { readonly initial: number }) {
  const [count, setCount] = useState(initial);
  return (
    <section>
      <h1>Clicked {count} times</h1>
      <button onClick={() => setCount((n) => n + 1)}>Increment</button>
    </section>
  );
}
