import React, { useState } from "react";

export default function Counter({ initial }: { readonly initial: number }) {
  const [count, setCount] = useState(initial);
  return <button onClick={() => setCount((n) => n + 1)}>Clicked {count} times</button>;
}
