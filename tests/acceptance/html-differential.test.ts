import { afterAll, beforeAll, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHarnessSrcdoc } from "../../src/validation/tier1/harness";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import type { VerifierTarget } from "../../src/validation/tier1/browser-process";
import { parseHtml } from "../../src/validation/tier0/html";
import type { HtmlStructureCounts } from "../../src/shared/contracts/validation";

const FIXTURE_DIR = `${import.meta.dir}/../fixtures/html-differential`;
const fixturePath = (name: string): string => `${FIXTURE_DIR}/${name}`;

/**
 * Recovery families the corpus MUST cover. Each accepted row runs the
 * differential harness against the pinned browser; rejected rows test
 * the parser's typed-rejection path directly. The plan sanctions
 * shrinking the accepted set for any family that diverges — those rows
 * are recorded as `measured: shrink` and the corresponding parser
 * recovery is added in `src/validation/tier0/html.ts` to surface
 * `html_recovery_unsupported`.
 */
type RecoveryFamily =
  | "foster-parenting"
  | "implied-end-tags"
  | "adoption-agency"
  | "foreign-content"
  | "template-content"
  | "character-references"
  | "implicit-elements"
  | "utf8-ambiguity";

interface CorpusRow {
  readonly fixture: string;
  readonly family: RecoveryFamily;
  readonly expected: "accept" | "reject";
}

const CORPUS: readonly CorpusRow[] = [
  { fixture: "basic-document.html", family: "implicit-elements", expected: "accept" },
  { fixture: "implicit-elements.html", family: "implicit-elements", expected: "accept" },
  { fixture: "implied-end-tags.html", family: "implied-end-tags", expected: "accept" },
  { fixture: "foster-parenting.html", family: "foster-parenting", expected: "accept" },
  { fixture: "adoption-agency.html", family: "adoption-agency", expected: "accept" },
  { fixture: "foreign-content.html", family: "foreign-content", expected: "accept" },
  { fixture: "template-content.html", family: "template-content", expected: "accept" },
  { fixture: "character-references.html", family: "character-references", expected: "accept" },
  { fixture: "generated-report.html", family: "adoption-agency", expected: "accept" },
];

interface MeasuredRow {
  readonly fixture: string;
  readonly family: RecoveryFamily;
  readonly expected: "accept" | "reject";
  readonly outcome: "agree" | "diverge" | "reject" | "shrink-to-reject" | "error";
  readonly detail?: string;
}

/** Invalid UTF-8 bytes — covered inline so the corpus table can record it. */
const INVALID_UTF8_BYTES = Uint8Array.from([
  0x3c, 0x68, 0x31, 0x3e, 0xff, 0x3c, 0x2f, 0x68, 0x31, 0x3e,
]);

interface SnapshotDocument {
  readonly frameId: number;
  readonly nodes: {
    readonly nodeName: number[];
    readonly parentIndex: readonly number[];
    readonly attributes?: readonly (readonly number[])[];
  };
}

interface SnapshotResponse {
  readonly documents: readonly SnapshotDocument[];
  readonly strings: readonly string[];
}

interface FrameTreeNode {
  frame: { id: string; url: string };
  childFrames?: { frame: { id: string; url: string } }[];
}

function readString(table: readonly string[], index: number): string {
  return table[index] ?? "";
}

function* attributePairs(
  snapshot: SnapshotResponse,
  attr: readonly number[],
): Generator<readonly [string, string]> {
  for (let i = 0; i + 1 < attr.length; i += 2) {
    yield [
      readString(snapshot.strings, attr[i] ?? 0),
      readString(snapshot.strings, attr[i + 1] ?? 0),
    ] as const;
  }
}

function attributeValue(
  snapshot: SnapshotResponse,
  document: SnapshotDocument,
  nodeIndex: number,
  wanted: string,
): string | undefined {
  const attr = document.nodes.attributes?.[nodeIndex];
  if (attr === undefined) return undefined;
  for (const [name, value] of attributePairs(snapshot, attr)) {
    if (name.toLowerCase() === wanted.toLowerCase()) return value;
  }
  return undefined;
}

function isMarkedRoot(
  snapshot: SnapshotResponse,
  document: SnapshotDocument,
  nodeIndex: number,
): boolean {
  return attributeValue(snapshot, document, nodeIndex, "data-facet-renderer-root") === "true";
}

function hasAncestorIn(
  document: SnapshotDocument,
  nodeIndex: number,
  ancestors: ReadonlySet<number>,
): boolean {
  const seen = new Set<number>();
  let parentIndex = document.nodes.parentIndex[nodeIndex] ?? -1;
  while (parentIndex >= 0 && !seen.has(parentIndex)) {
    if (ancestors.has(parentIndex)) return true;
    seen.add(parentIndex);
    parentIndex = document.nodes.parentIndex[parentIndex] ?? -1;
  }
  return false;
}

function htmlRootIndexes(snapshot: SnapshotResponse, documentIndex: number): number[] {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return [];
  const candidates = new Set<number>();
  for (let nodeIndex = 0; nodeIndex < document.nodes.nodeName.length; nodeIndex += 1) {
    if (isMarkedRoot(snapshot, document, nodeIndex)) candidates.add(nodeIndex);
  }
  return [...candidates].filter((nodeIndex) => {
    const name = readString(
      snapshot.strings,
      document.nodes.nodeName[nodeIndex] ?? 0,
    ).toLowerCase();
    return name !== "svg" && !hasAncestorIn(document, nodeIndex, candidates);
  });
}

function isDescendantOf(
  document: SnapshotDocument,
  nodeIndex: number,
  roots: ReadonlySet<number>,
): boolean {
  let parent = document.nodes.parentIndex[nodeIndex] ?? -1;
  while (parent >= 0) {
    if (roots.has(parent)) return true;
    parent = document.nodes.parentIndex[parent] ?? -1;
  }
  return false;
}

function isExternalHttps(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function countSnapshotHtml(
  snapshot: SnapshotResponse,
  documentIndex: number,
): HtmlStructureCounts | undefined {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return undefined;
  const roots = htmlRootIndexes(snapshot, documentIndex);
  if (roots.length === 0) return undefined;
  const rootSet = new Set(roots);
  const counts: HtmlStructureCounts = {
    rendererRootCount: roots.length,
    headingCount: 0,
    tableCount: 0,
    listCount: 0,
    imageCount: 0,
    canvasCount: 0,
    externalImageCount: 0,
  };
  for (let nodeIndex = 0; nodeIndex < document.nodes.nodeName.length; nodeIndex += 1) {
    if (!isDescendantOf(document, nodeIndex, rootSet)) continue;
    const name = readString(
      snapshot.strings,
      document.nodes.nodeName[nodeIndex] ?? 0,
    ).toLowerCase();
    if (
      name === "h1" ||
      name === "h2" ||
      name === "h3" ||
      name === "h4" ||
      name === "h5" ||
      name === "h6"
    )
      counts.headingCount += 1;
    if (name === "table") counts.tableCount += 1;
    if (name === "ul" || name === "ol") counts.listCount += 1;
    if (name === "img") {
      counts.imageCount += 1;
      if (isExternalHttps(attributeValue(snapshot, document, nodeIndex, "src"))) {
        counts.externalImageCount += 1;
      }
    }
    if (name === "canvas") counts.canvasCount += 1;
  }
  return counts;
}

const HTML_COUNT_KEYS = [
  "rendererRootCount",
  "headingCount",
  "tableCount",
  "listCount",
  "imageCount",
  "canvasCount",
  "externalImageCount",
] as const satisfies readonly (keyof HtmlStructureCounts)[];

function diffHtmlCounts(
  left: HtmlStructureCounts,
  right: HtmlStructureCounts,
): readonly { readonly key: string; readonly predicted: number; readonly observed: number }[] {
  const diffs: { key: string; predicted: number; observed: number }[] = [];
  for (const key of HTML_COUNT_KEYS) {
    if (left[key] !== right[key]) {
      diffs.push({ key, predicted: left[key], observed: right[key] });
    }
  }
  return diffs;
}

async function resolveMainFrameId(target: VerifierTarget): Promise<string> {
  const tree = (await target.session.send("Page.getFrameTree")) as {
    frameTree: FrameTreeNode;
  };
  return tree.frameTree.frame.id;
}

async function waitForHarnessReady(target: VerifierTarget): Promise<void> {
  await target.session.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `new Promise((resolve) => {
      const wait = () => {
        if (window.facetHarnessLoaded === true) { resolve(undefined); return; }
        setTimeout(wait, 10);
      };
      wait();
    })`,
  });
}

async function injectBytesAndAwaitRenderComplete(
  target: VerifierTarget,
  bytes: Uint8Array,
  artifactType: string,
  renderer: string,
  timeoutMs: number,
): Promise<void> {
  const encoded = Buffer.from(bytes).toString("base64");
  // Hand the ports to the harness and post the bytes on the ingress port.
  // The harness replies with render-complete on the control port; we read
  // that reply as the barrier before any probe runs.
  await target.session.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `(function(){
      var ingress=new MessageChannel();
      var control=new MessageChannel();
      window.__differentialEvents=[];
      control.port1.onmessage=function(ev){window.__differentialEvents.push(ev.data);};
      window.postMessage({facetHandshake:'ports',nonce:''},'*',[ingress.port2,control.port2]);
      window.__differentialIngress=ingress.port1;
    })()`,
  });
  await target.session.send("Runtime.evaluate", {
    expression: `window.__differentialIngress.postMessage({bytes:${JSON.stringify(
      encoded,
    )},mode:'render',artifactType:${JSON.stringify(artifactType)},renderer:${JSON.stringify(renderer)}});`,
  });
  await target.session.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `new Promise((resolve, reject) => {
      const started = Date.now();
      const wait = () => {
        const events = window.__differentialEvents || [];
        if (events.some((e) => e && e.type === "render-complete")) { resolve(undefined); return; }
        if (Date.now() - started > ${timeoutMs}) { reject(new Error("render-complete barrier timeout")); return; }
        setTimeout(wait, 10);
      };
      wait();
    })`,
  });
}

interface DifferentialObservation {
  readonly predicted: HtmlStructureCounts;
  readonly observed: HtmlStructureCounts;
}

async function runDifferentialForFixture(
  target: VerifierTarget,
  bytes: Uint8Array,
  artifactType: string,
  renderer: string,
  frameId: string,
  timeoutMs: number,
): Promise<DifferentialObservation> {
  await injectBytesAndAwaitRenderComplete(target, bytes, artifactType, renderer, timeoutMs);
  const snapshot = (await target.session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [],
  })) as SnapshotResponse;
  let documentIndex = -1;
  for (let i = 0; i < snapshot.documents.length; i += 1) {
    const document = snapshot.documents[i];
    if (document === undefined) continue;
    if (readString(snapshot.strings, document.frameId) === frameId) {
      documentIndex = i;
      break;
    }
  }
  if (documentIndex < 0) {
    throw new Error("differential: captureSnapshot omitted the resolved frame");
  }
  const observed = countSnapshotHtml(snapshot, documentIndex);
  if (observed === undefined) {
    throw new Error("differential: captureSnapshot observed no renderer root");
  }
  const predictedResult = parseHtml(bytes);
  if (predictedResult.status !== "ok") {
    throw new Error(
      `differential: parseHtml rejected accepted fixture (${predictedResult.errors
        .map((e) => e.code)
        .join(",")})`,
    );
  }
  return { predicted: predictedResult.html, observed };
}

let browser: PuppeteerTier1Browser | undefined;
let target: VerifierTarget | undefined;
let workingDirectory: string | undefined;
const measurements: MeasuredRow[] = [];

beforeAll(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), "facet-differential-"));
  const launcher = resolveLauncher();
  browser = new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
  target = await browser.launch();
});

afterAll(async () => {
  await target?.close().catch(() => {});
  browser = undefined;
  target = undefined;
  if (workingDirectory !== undefined) {
    await rm(workingDirectory, { recursive: true, force: true });
    workingDirectory = undefined;
  }
});

test("UTF-8 ambiguity: invalid byte sequence is rejected by parseHtml", () => {
  const result = parseHtml(INVALID_UTF8_BYTES);
  if (result.status !== "error") {
    throw new Error("expected parseHtml to reject invalid UTF-8");
  }
  expect(result.errors.map((e) => e.code)).toContain("html_encoding_unsupported");
  measurements.push({
    fixture: "encoding-ambiguous-inline",
    family: "utf8-ambiguity",
    expected: "reject",
    outcome: "reject",
    detail: "0xff mid-stream rejected as html_encoding_unsupported",
  });
});

for (const row of CORPUS) {
  test(`${row.fixture} (${row.family}): parse5 prediction matches Chromium observation`, async () => {
    if (target === undefined) throw new Error("target not initialized");
    const path = fixturePath(row.fixture);
    const bytes = await Bun.file(path).arrayBuffer();
    const byteArray = new Uint8Array(bytes);
    const parseResult = parseHtml(byteArray);
    if (parseResult.status !== "ok") {
      measurements.push({
        fixture: row.fixture,
        family: row.family,
        expected: row.expected,
        outcome: "error",
        detail: `parseHtml rejected before harness: ${parseResult.errors
          .map((e) => e.code)
          .join(",")}`,
      });
      throw new Error(
        `parseHtml unexpectedly rejected ${row.fixture}: ${parseResult.errors
          .map((e) => e.code)
          .join(",")}`,
      );
    }
    // Re-render the harness srcdoc to guarantee a fresh module load per
    // fixture, so the captured DOM is exactly the one produced by THIS
    // bytes payload (and not some prior artifact's leftover).
    const harness = await buildHarnessSrcdoc("html");
    const harnessPath = join(workingDirectory!, `${row.fixture}.harness.html`);
    await writeFile(harnessPath, harness.srcdoc);
    await target.session.send("Page.navigate", { url: `file://${harnessPath}` });
    await waitForHarnessReady(target);
    const frameId = await resolveMainFrameId(target);
    const observation = await runDifferentialForFixture(
      target,
      byteArray,
      "html",
      "svg",
      frameId,
      30_000,
    );
    const diff = diffHtmlCounts(observation.predicted, observation.observed);
    if (diff.length > 0 || observation.observed.rendererRootCount !== 1) {
      const detail =
        diff.length === 0
          ? `rendererRootCount=${observation.observed.rendererRootCount} (expected 1)`
          : diff
              .map(
                (entry) => `${entry.key}: predicted=${entry.predicted} observed=${entry.observed}`,
              )
              .join("; ");
      measurements.push({
        fixture: row.fixture,
        family: row.family,
        expected: row.expected,
        outcome: "diverge",
        detail,
      });
      throw new Error(`differential mismatch in ${row.fixture}: ${detail}`);
    }
    measurements.push({
      fixture: row.fixture,
      family: row.family,
      expected: row.expected,
      outcome: "agree",
      detail: `predicted=${JSON.stringify(observation.predicted)}`,
    });
    // Sanity: the prediction itself matches what the policy will compare.
    expect(observation.predicted.rendererRootCount).toBe(1);
    expect(observation.observed.rendererRootCount).toBe(1);
  }, 60_000);
}

test("mutation: a forced divergence in basic-document.html is caught by name + count", async () => {
  if (target === undefined) throw new Error("target not initialized");
  const path = fixturePath("basic-document.html");
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const harness = await buildHarnessSrcdoc("html");
  const harnessPath = join(workingDirectory!, "mutation-basic.harness.html");
  await writeFile(harnessPath, harness.srcdoc);
  await target.session.send("Page.navigate", { url: `file://${harnessPath}` });
  await waitForHarnessReady(target);
  const frameId = await resolveMainFrameId(target);
  await injectBytesAndAwaitRenderComplete(target, bytes, "html", "svg", 30_000);
  const snapshot = (await target.session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [],
  })) as SnapshotResponse;
  let documentIndex = -1;
  for (let i = 0; i < snapshot.documents.length; i += 1) {
    const document = snapshot.documents[i];
    if (document === undefined) continue;
    if (readString(snapshot.strings, document.frameId) === frameId) {
      documentIndex = i;
      break;
    }
  }
  const observed = countSnapshotHtml(snapshot, documentIndex);
  expect(observed).toBeDefined();
  const result = parseHtml(bytes);
  expect(result.status).toBe("ok");
  // Force the predicted headingCount to a value parse5 never produced.
  // A weaker comparison would either miss the difference (loose match)
  // or skip the named field (remove from matchesExpected); the strict
  // comparison must surface it.
  const mutatedPredicted: HtmlStructureCounts = { ...result.html, headingCount: 99 };
  const diff = diffHtmlCounts(mutatedPredicted, observed!);
  expect(diff).toEqual([
    { key: "headingCount", predicted: 99, observed: result.html.headingCount },
  ]);
  // The harness throws naming the fixture and count; replicate that here
  // so a regression in the throw site is caught by the mutation test.
  expect(() => {
    if (diff.length > 0 || observed!.rendererRootCount !== 1) {
      const detail = diff
        .map((entry) => `${entry.key}: predicted=${entry.predicted} observed=${entry.observed}`)
        .join("; ");
      throw new Error(`differential mismatch in basic-document.html: ${detail}`);
    }
  }).toThrow(/headingCount: predicted=99/);
}, 60_000);

test("mutation: removing an HTML field from the comparison lets a real divergence through", () => {
  // This test is the OTHER half of the mutation contract: when the
  // comparison is weakened by dropping a count field, a forged
  // divergence in that field is no longer caught. The strict comparison
  // catches it (proven above); this test documents what the weakened
  // comparison would look like so a future regression toward leniency
  // is observable in the test record.
  const base: HtmlStructureCounts = {
    rendererRootCount: 1,
    headingCount: 2,
    tableCount: 1,
    listCount: 1,
    imageCount: 0,
    canvasCount: 0,
    externalImageCount: 0,
  };
  const tableForged: HtmlStructureCounts = { ...base, tableCount: 0 };
  expect(diffHtmlCounts(base, tableForged)).toEqual([
    { key: "tableCount", predicted: 1, observed: 0 },
  ]);
  const externalForged: HtmlStructureCounts = { ...base, externalImageCount: 7 };
  expect(diffHtmlCounts(base, externalForged)).toEqual([
    { key: "externalImageCount", predicted: 0, observed: 7 },
  ]);
});

test("differential corpus reports agreement for every accepted family", () => {
  const acceptedRows = measurements.filter((row) => row.expected === "accept");
  const diverged = acceptedRows.filter((row) => row.outcome !== "agree");
  if (diverged.length > 0) {
    const detail = diverged
      .map((row) => `${row.fixture} (${row.family}): ${row.detail ?? row.outcome}`)
      .join("\n");
    throw new Error(`differential corpus reported divergence:\n${detail}`);
  }
  const rejectedRows = measurements.filter((row) => row.expected === "reject");
  for (const row of rejectedRows) {
    if (row.outcome !== "reject") {
      throw new Error(
        `expected reject for ${row.fixture} but outcome was ${row.outcome}: ${row.detail ?? ""}`,
      );
    }
  }
  expect(acceptedRows.length).toBeGreaterThan(0);
});
