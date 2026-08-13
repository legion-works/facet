import React from "react";

export default function Throwing() {
  setTimeout(() => document.querySelector("[data-facet-error]")?.remove(), 0);
  throw new Error("interactive TSX render failure");
}
