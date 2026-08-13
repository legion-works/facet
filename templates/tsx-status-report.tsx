import React from "react";

export default function StatusReport() {
  return (
    <section className="card bg-legion-paper p-6 w-full max-w-prose">
      <h1 className="text-2xl font-semibold text-legion-ink">Status report</h1>
      <p className="text-legion-muted mt-2">Verification state for the current release.</p>
      <section className="mt-4">
        <h2 className="text-lg font-semibold text-legion-ink">Counters</h2>
        <table className="table table-zebra mt-2 w-full">
          <thead>
            <tr>
              <th className="text-legion-ink">Metric</th>
              <th className="text-legion-ink">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Verified revisions</td>
              <td>12</td>
            </tr>
            <tr>
              <td>Open blockers</td>
              <td>0</td>
            </tr>
          </tbody>
        </table>
      </section>
    </section>
  );
}
