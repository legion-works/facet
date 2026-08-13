import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProtocolObservation, Tier0WorkerResult } from "../../src/shared/contracts/validation";
import type { VerifierCdpSession } from "../../src/validation/tier1/browser-process";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import {
  createIsolatedWorld,
  resolveNestedArtifactFrame,
  resolveSrcdocChildFrame,
} from "../../src/validation/tier1/frame-target";
import { buildHostPage } from "../../src/validation/tier1/harness";
import { probeIsolatedCounts } from "../../src/validation/tier1/isolated-probe";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import { TSX_STABILITY_WINDOW_MS } from "../../src/validation/tier1/limits";
import {
  probeProtocolGetDocument,
  probeProtocolSnapshot,
} from "../../src/validation/tier1/protocol-probe";
import { createTier0Runner } from "../../src/validation/tier0/runner";

const REPO_ROOT = join(import.meta.dir, "../..");
const FIXTURES_DIR = join(import.meta.dir, "../fixtures/tsx-measurement");
const TABLE_PATH = join(REPO_ROOT, "docs/verification/tsx-measurements.md");
const SAME_WORKER_COMPILE_COUNT = 20;
const RESTART_COMPILE_COUNT = 3;
const ZERO_LEXICAL = {
  rendererRootSvgCount: 0,
  mermaidNodeCount: 0,
  visibleSvgCount: 0,
  opaqueRegionCount: 0,
  externalImageCount: 0,
};

interface AcceptedFixture {
  readonly file: string;
  readonly label: string;
  readonly execution: "static" | "interactive";
  readonly marker?: string;
  readonly delayed?: boolean;
  readonly decoy?: boolean;
}

interface RejectedFixture {
  readonly file: string;
  readonly label: string;
  readonly expectedCode: "tsx_capability_fetch" | "tsx_capability_dynamic_import";
  readonly expectedMessage: string;
  readonly expectedLocation: string;
}

interface CompileMeasurement {
  readonly sameWorkerHashes: readonly string[];
  readonly restartHashes: readonly string[];
  readonly coldMs: number;
  readonly warmP50Ms: number;
  readonly outputBytes: number;
  readonly compiledBytes: Uint8Array;
}

interface ChannelObservation {
  readonly snapshot: ProtocolObservation;
  readonly document: ProtocolObservation;
  readonly isolated: ProtocolObservation;
}

interface InteractiveMeasurement {
  readonly first: ChannelObservation;
  readonly second: ChannelObservation;
  readonly selectedFrameId: string;
  readonly decoyFrameId: string | null;
}

const ACCEPTED: readonly AcceptedFixture[] = [
  { file: "static-report.tsx", label: "Static report", execution: "static" },
  { file: "static-conditional.tsx", label: "Static conditional", execution: "static" },
  {
    file: "interactive-stable.tsx",
    label: "Interactive stable state",
    execution: "interactive",
    marker: "interactive-stable",
  },
  {
    file: "interactive-effect.tsx",
    label: "Interactive immediate effect",
    execution: "interactive",
    marker: "interactive-effect:ready",
  },
  {
    file: "interactive-delayed.tsx",
    label: "Interactive delayed mutation",
    execution: "interactive",
    marker: "interactive-delayed",
    delayed: true,
  },
  {
    file: "interactive-decoy-frame.tsx",
    label: "Interactive nested decoy frame",
    execution: "interactive",
    marker: "interactive-decoy-frame",
    decoy: true,
  },
];

const REJECTED: readonly RejectedFixture[] = [
  {
    file: "rejected-network.tsx",
    label: "Rejected network capability",
    expectedCode: "tsx_capability_fetch",
    expectedMessage: 'TSX global "fetch(...)" is not allowed',
    expectedLocation: "4:8",
  },
  {
    file: "rejected-dynamic-import.tsx",
    label: "Rejected dynamic import",
    expectedCode: "tsx_capability_dynamic_import",
    expectedMessage: "TSX dynamic import() is not allowed",
    expectedLocation: "4:8",
  },
];

function percentile(values: readonly number[]): number {
  const sorted = [...values].toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? 0;
}

async function fixtureBytes(file: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.file(join(FIXTURES_DIR, file)).arrayBuffer());
}

function tier0Input(source: Uint8Array<ArrayBuffer>, execution: "static" | "interactive") {
  return {
    revisionSha: createHash("sha256").update(source).digest("hex"),
    artifactType: "tsx" as const,
    renderer: "svg" as const,
    source,
    lexical: ZERO_LEXICAL,
    execution,
  };
}

function compiledBytes(result: Tier0WorkerResult): Uint8Array {
  expect(result.status).toBe("ok");
  expect(result.compiled).toBeDefined();
  return Uint8Array.from(Buffer.from(result.compiled!.bytesBase64, "base64"));
}

function assertAllHashesEqual(label: string, hashes: readonly string[]): void {
  expect(hashes.length, `${label} must produce samples`).toBeGreaterThan(0);
  expect(new Set(hashes).size, `${label} compiler hashes diverged`).toBe(1);
}

async function measureAcceptedCompile(fixture: AcceptedFixture): Promise<CompileMeasurement> {
  const source = await fixtureBytes(fixture.file);
  const runner = createTier0Runner(0);
  const sameWorkerHashes: string[] = [];
  const warmMs: number[] = [];
  let coldMs = 0;
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  try {
    for (let index = 0; index < SAME_WORKER_COMPILE_COUNT; index += 1) {
      const startedAt = performance.now();
      bytes = compiledBytes(await runner(tier0Input(source, fixture.execution)));
      const durationMs = performance.now() - startedAt;
      sameWorkerHashes.push(createHash("sha256").update(bytes).digest("hex"));
      if (index === 0) coldMs = durationMs;
      else warmMs.push(durationMs);
    }
  } finally {
    runner.close?.();
  }
  if (fixture.execution === "static") {
    expect(new TextDecoder().decode(bytes)).toContain(
      `data-measurement-fixture="${fixture.file.replace(".tsx", "")}"`,
    );
  }
  const restartHashes: string[] = [];
  for (let index = 0; index < RESTART_COMPILE_COUNT; index += 1) {
    const restarted = createTier0Runner(0);
    try {
      const restartedBytes = compiledBytes(await restarted(tier0Input(source, fixture.execution)));
      restartHashes.push(createHash("sha256").update(restartedBytes).digest("hex"));
    } finally {
      restarted.close?.();
    }
  }
  assertAllHashesEqual(`${fixture.label} same-worker`, sameWorkerHashes);
  assertAllHashesEqual(`${fixture.label} restart`, restartHashes);
  expect(restartHashes[0]).toBe(sameWorkerHashes[0]);
  return {
    sameWorkerHashes,
    restartHashes,
    coldMs,
    warmP50Ms: percentile(warmMs),
    outputBytes: bytes.byteLength,
    compiledBytes: bytes,
  };
}

function projection(observation: ProtocolObservation): Record<string, unknown> {
  return {
    rendererRootSvgCount: observation.rendererRootSvgCount,
    graphCount: observation.graphCount,
    mermaidNodeCount: observation.mermaidNodeCount,
    visibleSvgCount: observation.visibleSvgCount,
    opaqueRegionCount: observation.opaqueRegionCount,
    externalImageCount: observation.externalImageCount,
    html: observation.html ?? null,
  };
}

function assertChannelAgreement(label: string, observation: ChannelObservation): void {
  expect(projection(observation.document), `${label} snapshot/getDocument divergence`).toEqual(
    projection(observation.snapshot),
  );
  expect(projection(observation.isolated), `${label} snapshot/isolated divergence`).toEqual(
    projection(observation.snapshot),
  );
}

function assertNonZeroObservation(label: string, observation: ChannelObservation): void {
  const values = Object.values(projection(observation.snapshot)).flatMap((value) =>
    value !== null && typeof value === "object" ? Object.values(value) : [value],
  );
  expect(
    values.some((value) => typeof value === "number" && value > 0),
    `${label} all-zero row`,
  ).toBe(true);
}

function observationsEqual(left: ChannelObservation, right: ChannelObservation): boolean {
  return JSON.stringify(projection(left.snapshot)) === JSON.stringify(projection(right.snapshot));
}

function observationSummary(observation: ProtocolObservation): string {
  const html = observation.html;
  return html === undefined
    ? `svg=${observation.rendererRootSvgCount}; graph=${observation.graphCount}; opaque=${observation.opaqueRegionCount}`
    : `root=${html.rendererRootCount}; h=${html.headingCount}; t=${html.tableCount}; l=${html.listCount}; i=${html.imageCount}; c=${html.canvasCount}`;
}

async function buildGallery(): Promise<void> {
  const child = Bun.spawn([process.execPath, "scripts/build-gallery.ts"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`gallery build failed: ${stderr}`);
}

async function waitFor<T>(label: string, read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function hostEvent(session: VerifierCdpSession, type: string): Promise<void> {
  await waitFor(type, async () => {
    const result = (await session.send("Runtime.evaluate", {
      expression: `JSON.stringify((window.__facetShimEvents || []).some(function(event){return event.type === ${JSON.stringify(type)};}))`,
      returnByValue: true,
    })) as { result?: { value?: string } };
    return result.result?.value === "true" ? true : null;
  });
}

async function fixtureMarker(
  session: VerifierCdpSession,
  executionContextId: number,
  marker: string,
): Promise<void> {
  await waitFor(marker, async () => {
    const result = (await session.send("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression:
        "document.querySelector('[data-measurement-fixture]')?.getAttribute('data-measurement-fixture') || null",
    })) as { result?: { value?: string | null } };
    return result.result?.value === marker ? marker : null;
  });
}

function siblingDecoyFrameId(
  tree: unknown,
  outerFrameId: string,
  selectedFrameId: string,
): string | null {
  const walk = (node: { frame?: { id?: string }; childFrames?: unknown[] }): string | null => {
    if (node.frame?.id === outerFrameId) {
      const candidates = (node.childFrames ?? [])
        .map((child) => (child as { frame?: { id?: string } }).frame?.id)
        .filter((id): id is string => id !== undefined);
      return candidates.find((id) => id !== selectedFrameId) ?? null;
    }
    for (const child of node.childFrames ?? []) {
      const found = walk(child as { frame?: { id?: string }; childFrames?: unknown[] });
      if (found !== null) return found;
    }
    return null;
  };
  return walk(
    (tree as { frameTree: { frame?: { id?: string }; childFrames?: unknown[] } }).frameTree,
  );
}

async function observeInteractive(
  session: VerifierCdpSession,
  fixture: AcceptedFixture,
  bytes: Uint8Array,
): Promise<InteractiveMeasurement> {
  const hostDir = mkdtempSync(join(tmpdir(), "facet-tsx-measurement-"));
  try {
    const host = await buildHostPage(bytes, "render", hostDir, "tsx", "svg", "interactive");
    if (fixture.decoy) {
      const harness = await Bun.file(host.harnessPath).text();
      writeFileSync(
        host.harnessPath,
        harness.replace(
          '<main id="artifact"',
          '<iframe id="measurement-decoy" srcdoc=\'<!doctype html><main data-facet-renderer-root="true"><h1>Decoy report</h1><h2>Do not select this frame</h2></main>\'></iframe><main id="artifact"',
        ),
        "utf8",
      );
    }
    const hostPath = join(hostDir, "host.html");
    writeFileSync(hostPath, host.html, "utf8");
    const navigation = (await session.send("Page.navigate", { url: `file://${hostPath}` })) as {
      errorText?: string;
    };
    if (navigation.errorText !== undefined)
      throw new Error(`measurement navigation: ${navigation.errorText}`);
    await hostEvent(session, "boot-ready");
    await session.send("Runtime.evaluate", {
      expression:
        "window.__facetHostArtifact.ingress.postMessage({bytes:window.__facetHostArtifact.bytes,mode:window.__facetHostArtifact.mode,artifactType:window.__facetHostArtifact.artifactType,renderer:window.__facetHostArtifact.renderer,execution:window.__facetHostArtifact.execution});",
    });
    await hostEvent(session, "render-complete");
    const outer = await resolveSrcdocChildFrame(session);
    const selected = await resolveNestedArtifactFrame(session, outer);
    const isolated = await createIsolatedWorld(session, selected.frameId);
    await fixtureMarker(session, isolated.executionContextId, fixture.marker!);
    const observe = async (): Promise<ChannelObservation> => {
      const isolatedObservation = await probeIsolatedCounts(session, isolated.executionContextId);
      if (isolatedObservation === null)
        throw new Error("isolated measurement probe returned no observation");
      return {
        snapshot: await probeProtocolSnapshot(session, selected),
        document: await probeProtocolGetDocument(session, selected),
        isolated: isolatedObservation,
      };
    };
    const first = await observe();
    await Bun.sleep(TSX_STABILITY_WINDOW_MS);
    const second = await observe();
    return {
      first,
      second,
      selectedFrameId: selected.frameId,
      decoyFrameId: fixture.decoy
        ? siblingDecoyFrameId(
            await session.send("Page.getFrameTree"),
            outer.frameId,
            selected.frameId,
          )
        : null,
    };
  } finally {
    rmSync(hostDir, { recursive: true, force: true });
  }
}

function normalizeTimingCells(table: string): string {
  return table
    .split("\n")
    .map((line) => {
      if (!line.startsWith("|")) return line;
      if (/^\|\s*-/.test(line)) return "| table-separator |";
      const cells = line.split("|").map((cell) => cell.trim());
      if (cells.length >= 12) cells[6] = "host-local";
      if (cells.length >= 12) {
        cells[11] = cells[11]!
          .replace(/selected=[A-F0-9]+/g, "selected=runtime-frame")
          .replace(/decoy=[A-F0-9]+/g, "decoy=runtime-frame");
      }
      return cells.join("|");
    })
    .join("\n");
}

function measurementTable(
  compiled: ReadonlyMap<string, CompileMeasurement>,
  observed: ReadonlyMap<string, InteractiveMeasurement>,
): string {
  const rows = ACCEPTED.map((fixture) => {
    const compile = compiled.get(fixture.file)!;
    const channels = observed.get(fixture.file);
    const pair = (channel: keyof ChannelObservation) =>
      channels === undefined
        ? "—"
        : `${observationSummary(channels.first[channel])} → ${observationSummary(channels.second[channel])}`;
    const finalStatus = fixture.delayed
      ? "partial:unstable"
      : fixture.execution === "interactive"
        ? "ok"
        : "accepted";
    return [
      fixture.label,
      fixture.execution,
      "accept",
      `${compile.sameWorkerHashes[0]} × ${compile.sameWorkerHashes.length}`,
      `${compile.restartHashes[0]} × ${compile.restartHashes.length}`,
      `${compile.coldMs.toFixed(1)} / ${compile.warmP50Ms.toFixed(1)}`,
      String(compile.outputBytes),
      pair("snapshot"),
      pair("document"),
      pair("isolated"),
      fixture.decoy && channels !== undefined
        ? `${finalStatus}; selected=${channels.selectedFrameId}; decoy=${channels.decoyFrameId}`
        : finalStatus,
    ];
  });
  for (const fixture of REJECTED) {
    rows.push([
      fixture.label,
      "interactive",
      `reject: ${fixture.expectedCode}`,
      "no compiled output",
      "no compiled output",
      "—",
      "—",
      "—",
      "—",
      "—",
      `error: ${fixture.expectedCode}`,
    ]);
  }
  return [
    "# TSX compiler and authority measurements",
    "",
    "Generated by `tests/acceptance/tsx-measurement.test.ts`. Hashes, byte counts, channel counts, and statuses are exact gates. Cold/warm milliseconds are host-sensitive evidence (`cold / warm p50`) and are normalized only for the committed-table check.",
    "",
    "Hash invariant: identical source bytes, absolute entrypoint, cwd, and environment. Same-worker and restarted-worker hashes are measured separately. Interactive hashes cover the generated mount entry that ships to the nested frame.",
    "",
    "| Fixture | Mode | Expected accept/reject | Same-worker hashes | Restart hashes | Cold/warm ms | Bytes | Snapshot A/B | getDocument A/B | Isolated A/B | Final status |",
    "|---|---|---|---|---|---|---:|---|---|---|---|",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    "",
    "Interactive rows require a fixture-owned `data-measurement-fixture` marker and a non-zero observation before recording counts. A zero row is rejected as an unexecuted artifact, not accepted as evidence.",
    "",
  ].join("\n");
}

test("measures TSX compile determinism and nested authority without zero-observation rows", async () => {
  const compiled = new Map<string, CompileMeasurement>();
  for (const fixture of ACCEPTED) compiled.set(fixture.file, await measureAcceptedCompile(fixture));

  const rejectionRunner = createTier0Runner(0);
  try {
    for (const fixture of REJECTED) {
      const source = await fixtureBytes(fixture.file);
      const result = await rejectionRunner(tier0Input(source, "interactive"));
      expect(result.status).toBe("error");
      expect(result.compiled).toBeUndefined();
      expect(result.observed.discriminativeErrors).toEqual([
        {
          code: fixture.expectedCode,
          message: fixture.expectedMessage,
          location: fixture.expectedLocation,
        },
      ]);
    }
  } finally {
    rejectionRunner.close?.();
  }

  await buildGallery();
  const launcher = resolveLauncher();
  const browser = new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
  const target = await browser.launch();
  const observed = new Map<string, InteractiveMeasurement>();
  try {
    await target.session.send("Runtime.enable");
    await target.session.send("Page.enable");
    for (const fixture of ACCEPTED.filter((entry) => entry.execution === "interactive")) {
      const measurement = await observeInteractive(
        target.session,
        fixture,
        compiled.get(fixture.file)!.compiledBytes,
      );
      assertChannelAgreement(`${fixture.label} A`, measurement.first);
      assertChannelAgreement(`${fixture.label} B`, measurement.second);
      assertNonZeroObservation(`${fixture.label} A`, measurement.first);
      assertNonZeroObservation(`${fixture.label} B`, measurement.second);
      if (fixture.delayed)
        expect(observationsEqual(measurement.first, measurement.second)).toBe(false);
      else expect(observationsEqual(measurement.first, measurement.second)).toBe(true);
      if (fixture.decoy) {
        expect(measurement.decoyFrameId).not.toBeNull();
        expect(measurement.decoyFrameId).not.toBe(measurement.selectedFrameId);
        expect(measurement.first.snapshot.html?.headingCount).toBe(1);
      }
      observed.set(fixture.file, measurement);
    }
  } finally {
    await target.close();
  }

  const generated = measurementTable(compiled, observed);
  if (process.env.FACET_UPDATE_TSX_MEASUREMENTS === "1") await Bun.write(TABLE_PATH, generated);
  else
    expect(normalizeTimingCells(await Bun.file(TABLE_PATH).text())).toBe(
      normalizeTimingCells(generated),
    );
}, 180_000);
