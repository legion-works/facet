import React from "react";

const regions = [
  { name: "north", ready: 18, total: 20, queue: 6, latency: 182 },
  { name: "core", ready: 14, total: 16, queue: 4, latency: 196 },
  { name: "edge", ready: 10, total: 12, queue: 8, latency: 218 },
] as const;

export default function CapacityReport() {
  const readyWorkers = regions.reduce((total, region) => total + region.ready, 0);
  const workerCapacity = regions.reduce((total, region) => total + region.total, 0);
  const queuedRevisions = regions.reduce((total, region) => total + region.queue, 0);
  const averageLatency = Math.round(
    regions.reduce((total, region) => total + region.latency, 0) / regions.length,
  );
  const capacityPercent = Math.round((readyWorkers / workerCapacity) * 100);

  return (
    <main className="max-w-2xl p-6 gap-6 flex flex-col bg-legion-paper text-legion-ink">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <span className="badge">capacity report</span>
          <span className="badge">static render</span>
          <span className="badge">{capacityPercent}% ready</span>
        </div>
        <h1 className="text-2xl font-bold">Capacity report</h1>
        <p className="text-sm text-legion-muted">
          Worker readiness, queued revisions, and visual verification latency by operating region.
        </p>
      </header>

      <section className="grid grid-cols-3 gap-4" aria-label="capacity summary">
        <article className="stat card border border-legion-line rounded-box p-4 gap-2 flex flex-col">
          <span className="text-xs text-legion-muted">ready workers</span>
          <strong className="text-2xl font-bold">{readyWorkers}</strong>
          <span className="text-xs text-legion-cyan">of {workerCapacity} scheduled</span>
        </article>
        <article className="stat card border border-legion-line rounded-box p-4 gap-2 flex flex-col">
          <span className="text-xs text-legion-muted">queued revisions</span>
          <strong className="text-2xl font-bold">{queuedRevisions}</strong>
          <span className="text-xs text-legion-muted">across {regions.length} regions</span>
        </article>
        <article className="stat card border border-legion-line rounded-box p-4 gap-2 flex flex-col">
          <span className="text-xs text-legion-muted">average visual latency</span>
          <strong className="text-2xl font-bold">{averageLatency} ms</strong>
          <span className="text-xs text-legion-cyan">within 250 ms target</span>
        </article>
      </section>

      <section className="card border border-legion-line rounded-box p-4 gap-3 flex flex-col">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Regional allocation</h2>
          <span className="badge">revision-bound</span>
        </div>
        <div className="overflow-x-auto">
          <table className="table table-zebra w-full">
            <thead>
              <tr>
                <th className="text-left">region</th>
                <th className="text-right">ready</th>
                <th className="text-right">queue</th>
                <th className="text-right">visual latency</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((region) => (
                <tr key={region.name}>
                  <td>{region.name}</td>
                  <td className="text-right">
                    {region.ready} / {region.total}
                  </td>
                  <td className="text-right">{region.queue}</td>
                  <td className="text-right">{region.latency} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <article className="card border border-legion-line rounded-box p-4 gap-2 flex flex-col">
          <h2 className="text-lg font-semibold">Readiness signal</h2>
          <p className="text-sm text-legion-muted">
            {readyWorkers} workers are ready. {workerCapacity - readyWorkers} remain reserved for
            maintenance and recovery.
          </p>
          <span className="text-lg font-semibold text-legion-cyan">
            ✓ {capacityPercent}% capacity online
          </span>
        </article>
        <article className="card border border-legion-line rounded-box p-4 gap-2 flex flex-col">
          <h2 className="text-lg font-semibold">Planning note</h2>
          <p className="text-sm text-legion-muted">
            Keep edge capacity fixed until its queue drops below the current 8-revision threshold.
          </p>
          <span className="text-sm">→ review after the next visual verification window</span>
        </article>
      </section>
    </main>
  );
}
