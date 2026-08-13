import React from "react";

export default function DynamicImportAttempt() {
  void import("reporting-plugin");
  return <p data-measurement-fixture="rejected-dynamic-import">Dynamic import attempt</p>;
}
