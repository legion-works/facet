import React from "react";

export default function NetworkAttempt() {
  void fetch("https://example.invalid/report");
  return <p data-measurement-fixture="rejected-network">Network attempt</p>;
}
