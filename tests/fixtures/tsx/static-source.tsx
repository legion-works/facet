import React from "react";

export default function Status({ label }: { readonly label: string }) {
  return (
    <main>
      <h1>Static status</h1>
      <p className="text-sm">{label}</p>
    </main>
  );
}
