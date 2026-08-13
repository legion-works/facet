import React from "react";

/**
 * Publish static by default, or select interactive explicitly:
 * `facet publish --artifact-id <id> --type tsx --file templates/tsx-status-report.tsx`
 */
export default function StatusReport() {
  return (
    <main>
      <h1>Status report</h1>
      <p>Verification state for the current release.</p>
      <section>
        <h2>Counters</h2>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Value</th>
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
    </main>
  );
}
