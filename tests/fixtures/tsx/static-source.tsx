import React from "react";

export default function Status({ label }: { readonly label: string }) {
  return <p className="text-sm">{label}</p>;
}
