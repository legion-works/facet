import React, { useEffect, useState } from "react";

const WIDE_BREAKPOINT_PX = 1600;
const PANEL_COUNT = 6;

function columnsForWidth(width: number): number {
  return width >= WIDE_BREAKPOINT_PX ? 3 : 2;
}

export default function ResponsiveDashboard() {
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const columns = columnsForWidth(width);

  return (
    <main>
      <div role="toolbar">
        <button type="button">Refresh</button>
        <span data-facet-column-readout>{columns} columns</span>
      </div>
      <div
        data-facet-grid
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: "8px",
        }}
      >
        {Array.from({ length: PANEL_COUNT }).map((_, index) => (
          <div key={index}>Panel {index + 1}</div>
        ))}
      </div>
    </main>
  );
}
