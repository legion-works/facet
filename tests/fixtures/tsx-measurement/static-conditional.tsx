import React from "react";

export default function ConditionalReport({ compact = false }: { readonly compact?: boolean }) {
  return (
    <section data-measurement-fixture="static-conditional">
      <h1>Delivery summary</h1>
      {compact ? (
        <p>Compact summary</p>
      ) : (
        <table>
          <tbody>
            <tr>
              <td>Artifacts</td>
              <td>verified</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
