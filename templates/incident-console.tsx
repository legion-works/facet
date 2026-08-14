import React, { useState } from "react";

type Severity = "all" | "critical" | "warning" | "info";

const incidents = [
  {
    id: "INC-482",
    severity: "critical",
    service: "visual verifier",
    summary: "Browser lease saturation in north region",
    owner: "release systems",
    age: "18m",
  },
  {
    id: "INC-479",
    severity: "warning",
    service: "evidence ledger",
    summary: "Retention sweep delayed behind export queue",
    owner: "storage control",
    age: "42m",
  },
  {
    id: "INC-476",
    severity: "info",
    service: "publish intake",
    summary: "New revision volume above weekly baseline",
    owner: "build systems",
    age: "1h 12m",
  },
] as const;

const severities: Severity[] = ["all", "critical", "warning", "info"];

export default function IncidentConsole() {
  const [severity, setSeverity] = useState<Severity>("all");
  const [selectedId, setSelectedId] = useState(incidents[0].id);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const filteredIncidents = incidents.filter(
    (incident) => severity === "all" || incident.severity === severity,
  );
  const selectedIncident =
    filteredIncidents.find((incident) => incident.id === selectedId) ?? filteredIncidents[0];
  const criticalCount = incidents.filter((incident) => incident.severity === "critical").length;

  return (
    <main className="max-w-2xl p-6 gap-6 flex flex-col bg-legion-paper text-legion-ink">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="badge">incident console</span>
          <span className="badge">{autoRefresh ? "live refresh" : "manual refresh"}</span>
          <span className="badge">{criticalCount} critical</span>
        </div>
        <h1 className="text-2xl font-bold">Incident console</h1>
        <p className="text-sm text-legion-muted">
          Current exceptions across the release and verification surfaces.
        </p>
      </header>

      <section
        className="alert border border-legion-line rounded-box p-4 flex flex-col gap-2"
        role="status"
      >
        <strong className="font-semibold">{criticalCount} critical incident requires review</strong>
        <span className="text-sm text-legion-muted">
          Auto refresh is {autoRefresh ? "enabled" : "paused"}; selection remains local to this
          console.
        </span>
      </section>

      <section className="flex flex-wrap gap-2" aria-label="severity filters">
        {severities.map((nextSeverity) => (
          <button
            key={nextSeverity}
            type="button"
            className="btn border border-legion-line px-3 py-2 rounded"
            onClick={() => setSeverity(nextSeverity)}
          >
            {nextSeverity}
          </button>
        ))}
        <button
          type="button"
          className="btn bg-legion-cyan text-legion-ink px-3 py-2 rounded"
          onClick={() => setAutoRefresh((value) => !value)}
        >
          {autoRefresh ? "Pause refresh" : "Resume refresh"}
        </button>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <article className="card border border-legion-line rounded-box p-4 gap-3 flex flex-col">
          <h2 className="text-lg font-semibold">Active incidents</h2>
          <div className="flex flex-col gap-2">
            {filteredIncidents.map((incident) => (
              <button
                key={incident.id}
                type="button"
                className="btn border border-legion-line p-3 rounded text-left flex flex-col gap-2"
                onClick={() => setSelectedId(incident.id)}
              >
                <span className="flex items-center justify-between gap-2">
                  <strong className="font-medium">{incident.id}</strong>
                  <span className="badge">{incident.severity}</span>
                </span>
                <span className="text-sm text-legion-muted">{incident.summary}</span>
              </button>
            ))}
          </div>
        </article>

        <article className="card border border-legion-line rounded-box p-4 gap-3 flex flex-col">
          <h2 className="text-lg font-semibold">Incident detail</h2>
          {selectedIncident ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xl font-bold">{selectedIncident.id}</span>
                <span className="badge">{selectedIncident.severity}</span>
              </div>
              <p className="text-sm">{selectedIncident.summary}</p>
              <table className="table table-zebra w-full">
                <tbody>
                  <tr>
                    <td>service</td>
                    <td className="text-right">{selectedIncident.service}</td>
                  </tr>
                  <tr>
                    <td>owner</td>
                    <td className="text-right">{selectedIncident.owner}</td>
                  </tr>
                  <tr>
                    <td>age</td>
                    <td className="text-right">{selectedIncident.age}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-legion-muted">
              No incidents match the active severity filter.
            </p>
          )}
        </article>
      </section>
    </main>
  );
}
