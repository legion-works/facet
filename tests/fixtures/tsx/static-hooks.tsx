import { useState } from "react";

export default function Counter() {
  const [count] = useState(0);

  return (
    <div>
      <h1>Counter</h1>
      <button>Clicked {count}</button>
    </div>
  );
}
