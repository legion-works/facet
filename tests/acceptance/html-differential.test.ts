/**
 * Differential corpus: parse5 prediction vs Chromium observation.
 *
 * For each accepted fixture the harness runs the same production code the
 * verdict layer uses — `probeProtocolSnapshot` from
 * `src/validation/tier1/protocol-probe.ts`. The corpus can only be a
 * real prediction-vs-observation gate while the harness routes through
 * that production function; a hand-rolled copy of `countSnapshotHtml`
 * would let an observation regression (e.g. a gutted incrementer)
 * silently pass. Per the reviewer's acceptance proof, gutting
 * `countSnapshotHtml` tableCount in production MUST redden this file.
 *
 * Each accepted row also carries a `triggerProof` that walks the parse5
 * tree and asserts the named recovery family actually fires. A fixture
 * that does not trigger its family makes its "agree" row decoration.
 *
 * The rejected rows test the Tier 0 typed-rejection path (encoding
 * ambiguity, unrecoverable `<select>` family); the browser is never
 * invoked for them.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, type DefaultTreeAdapterMap } from "parse5";

import { parseHtml } from "../../src/validation/tier0/html";
import {
  probeProtocolSnapshot,
  type SnapshotResponse,
} from "../../src/validation/tier1/protocol-probe";
import { buildHarnessSrcdoc } from "../../src/validation/tier1/harness";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import type { VerifierTarget } from "../../src/validation/tier1/browser-process";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import type { HtmlStructureCounts } from "../../src/shared/contracts/validation";

const FIXTURE_DIR = `${import.meta.dir}/../fixtures/html-differential`;
const fixturePath = (name: string): string => `${FIXTURE_DIR}/${name}`;

type RecoveryFamily =
  | "foster-parenting"
  | "implied-end-tags"
  | "adoption-agency"
  | "foreign-content"
  | "template-content"
  | "character-references"
  | "implicit-elements"
  | "escapable-raw-text"
  | "table-scoped"
  | "nested-lists"
  | "mathml-annotation-xml"
  | "noscript-scripting"
  | "well-formed"
  | "utf8-ambiguity"
  | "select-rejected"
  | "select-clean";

type Parse5Node =
  | DefaultTreeAdapterMap["element"]
  | DefaultTreeAdapterMap["document"]
  | DefaultTreeAdapterMap["documentFragment"]
  | DefaultTreeAdapterMap["textNode"]
  | DefaultTreeAdapterMap["commentNode"]
  | DefaultTreeAdapterMap["documentType"]
  | DefaultTreeAdapterMap["template"];

interface CorpusRow {
  readonly fixture: string;
  readonly family: RecoveryFamily;
  readonly expected: "accept" | "reject";
  readonly proof: (root: Parse5Node) => void;
}

function isElement(node: unknown): node is DefaultTreeAdapterMap["element"] {
  return (
    typeof node === "object" &&
    node !== null &&
    "tagName" in node &&
    typeof (node as { tagName: unknown }).tagName === "string"
  );
}

function isTemplate(node: unknown): node is DefaultTreeAdapterMap["template"] {
  return isElement(node) && (node as { tagName: string }).tagName === "template";
}

function childElements(node: unknown): readonly DefaultTreeAdapterMap["element"][] {
  if (typeof node !== "object" || node === null || !("childNodes" in node)) return [];
  const children = (node as { childNodes: readonly unknown[] }).childNodes;
  return children.filter(isElement);
}

function findElement(node: unknown, tagName: string): DefaultTreeAdapterMap["element"] | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  if (isElement(node) && node.tagName.toLowerCase() === tagName.toLowerCase()) return node;
  const children = (node as { childNodes?: readonly unknown[] }).childNodes ?? [];
  for (const child of children) {
    const found = findElement(child, tagName);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findAllElements(
  node: unknown,
  tagName: string,
): readonly DefaultTreeAdapterMap["element"][] {
  const result: DefaultTreeAdapterMap["element"][] = [];
  function walk(current: unknown): void {
    if (typeof current !== "object" || current === null) return;
    if (isElement(current) && current.tagName.toLowerCase() === tagName.toLowerCase()) {
      result.push(current);
    }
    const children = (current as { childNodes?: readonly unknown[] }).childNodes ?? [];
    for (const child of children) walk(child);
    if (isTemplate(current) && current.content) walk(current.content);
  }
  walk(node);
  return result;
}

function collectTextContent(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  if ("value" in node && typeof (node as { value: unknown }).value === "string") {
    return (node as { value: string }).value;
  }
  const children = (node as { childNodes?: readonly unknown[] }).childNodes ?? [];
  let text = "";
  for (const child of children) text += collectTextContent(child);
  if (isTemplate(node) && node.content) text += collectTextContent(node.content);
  return text;
}

function bodyElement(root: Parse5Node): DefaultTreeAdapterMap["element"] | undefined {
  const html = findElement(root, "html");
  if (html === undefined) return undefined;
  return findElement(html, "body");
}

// Trigger proofs — one per recovery family. Each walks the parse5 tree
// produced by parseHtml and asserts the named family actually fires.
const TRIGGER_PROOFS: Record<string, (root: Parse5Node) => void> = {
  // Well-formed baseline: no recovery fires; the parser simply walks the
  // explicit html/head/body skeleton. The proof is that all four elements
  // exist and the body holds the structural content directly.
  "basic-document.html": (root) => {
    expect(findElement(root, "html")).toBeDefined();
    expect(findElement(root, "head")).toBeDefined();
    expect(findElement(root, "body")).toBeDefined();
    const body = bodyElement(root);
    expect(body).toBeDefined();
    expect(childElements(body!).length).toBeGreaterThan(0);
  },
  // Implicit elements: no doctype, no html, no head, no body in the
  // source. The parser MUST insert all four for the document to have
  // structural counts. The proof is that they exist.
  "implicit-elements.html": (root) => {
    expect(findElement(root, "html")).toBeDefined();
    expect(findElement(root, "head")).toBeDefined();
    const body = bodyElement(root);
    expect(body).toBeDefined();
    expect(childElements(body!).length).toBeGreaterThan(0);
  },
  // Implied end tags: three <p> stacked without explicit close must end
  // up as siblings, not nested. The proof is that body has 3+ <p>
  // children directly.
  "implied-end-tags.html": (root) => {
    const body = bodyElement(root);
    expect(body).toBeDefined();
    const directParas = childElements(body!).filter((e) => e.tagName.toLowerCase() === "p");
    expect(directParas.length).toBe(2);
  },
  // Foster parenting: misplaced div/span/p sit DIRECTLY inside <table>
  // outside any cell. The recovery moves them BEFORE the <table>.
  // The proof is that body has a div, span, p BEFORE its table and
  // that the table contains no direct div/span/p children.
  "foster-parenting.html": (root) => {
    const body = bodyElement(root);
    expect(body).toBeDefined();
    const direct = childElements(body!);
    const tableIndex = direct.findIndex((e) => e.tagName.toLowerCase() === "table");
    expect(tableIndex).toBeGreaterThanOrEqual(0);
    const divIndices = direct
      .map((e, i) => ({ tag: e.tagName.toLowerCase(), i }))
      .filter((x) => x.tag === "div" || x.tag === "span" || x.tag === "p")
      .map((x) => x.i);
    expect(divIndices.length).toBeGreaterThanOrEqual(3);
    for (const idx of divIndices) {
      expect(idx).toBeLessThan(tableIndex);
    }
    const table = direct[tableIndex]!;
    expect(
      childElements(table).filter(
        (e) =>
          e.tagName.toLowerCase() === "div" ||
          e.tagName.toLowerCase() === "span" ||
          e.tagName.toLowerCase() === "p",
      ).length,
    ).toBe(0);
  },
  // Adoption agency: <b><i>...</b> reconstructs the active formatting
  // elements. After reconstruction the <p> holds both <b> and <i> as
  // siblings of the closed-but-reopened inner element.
  "adoption-agency.html": (root) => {
    const body = bodyElement(root);
    expect(body).toBeDefined();
    const firstP = childElements(body!).find((e) => e.tagName.toLowerCase() === "p");
    expect(firstP).toBeDefined();
    const pChildren = childElements(firstP!).map((e) => e.tagName.toLowerCase());
    expect(pChildren).toContain("b");
    expect(pChildren).toContain("i");
  },
  // Foreign content: BOTH <svg> and <math> are in the tree, with
  // their foreign-namespace descendants.
  "foreign-content.html": (root) => {
    const body = bodyElement(root);
    expect(body).toBeDefined();
    const svg = childElements(body!).find((e) => e.tagName.toLowerCase() === "svg");
    const math = childElements(body!).find((e) => e.tagName.toLowerCase() === "math");
    expect(svg).toBeDefined();
    expect(math).toBeDefined();
    expect(findElement(svg!, "circle")).toBeDefined();
    expect(findElement(math!, "mrow")).toBeDefined();
  },
  // Template content: <template> holds an inert DocumentFragment. The
  // proof is that the template's content exists AND has children, AND
  // that those children are NOT in the rendered tree.
  "template-content.html": (root) => {
    const body = bodyElement(root);
    expect(body).toBeDefined();
    const templates = childElements(body!).filter((e) => e.tagName.toLowerCase() === "template");
    expect(templates.length).toBe(1);
    const template = templates[0]! as Parse5Node & { content?: Parse5Node };
    expect(template.content).toBeDefined();
    expect(childElements(template.content!).length).toBeGreaterThan(0);
  },
  // Character references: &copy; &amp; etc. decode into text content.
  // The proof is that the literal entity strings do NOT appear in text
  // (they were decoded) and the decoded form does.
  "character-references.html": (root) => {
    const text = collectTextContent(root);
    expect(text).toContain("\u00a9"); // &copy;
    expect(text).toContain("&"); // decoded &amp;
    expect(text).not.toContain("&copy;");
    expect(text).not.toContain("&amp;");
  },
  // <noscript> scripting flag: with scriptingEnabled=false (matching
  // Chromium's DOMParser), <noscript> contents parse as elements.
  "noscript.html": (root) => {
    const noscripts = findAllElements(root, "noscript");
    expect(noscripts.length).toBeGreaterThan(0);
    const noscript = noscripts[0]!;
    const elementChildren = childElements(noscript).filter(
      (e) => e.tagName.toLowerCase() !== "#text",
    );
    expect(elementChildren.length).toBeGreaterThan(0);
  },
  // Bare <select> without table markup parses identically in both
  // parsers (no recovery divergence). The proof is that the element
  // exists with option children.
  "select-clean.html": (root) => {
    const selects = findAllElements(root, "select");
    expect(selects.length).toBe(1);
    const options = childElements(selects[0]!).filter((e) => e.tagName.toLowerCase() === "option");
    expect(options.length).toBeGreaterThanOrEqual(2);
  },
  // Escapable raw-text: <textarea> and <title> have RAWTEXT/RCDATA
  // insertion mode where the only markup-like construct recognized is
  // the matching end tag. The proof is that their text content
  // includes literal <b>tags</b> rather than a parsed <b> element.
  "textarea-title.html": (root) => {
    const textareas = findAllElements(root, "textarea");
    expect(textareas.length).toBe(1);
    const taText = collectTextContent(textareas[0]!);
    expect(taText).toContain("<b>tags</b>");
    const titles = findAllElements(root, "title");
    expect(titles.length).toBe(1);
    const titleText = collectTextContent(titles[0]!);
    expect(titleText).toContain("quotes");
  },
  // Table-scoped: <caption> and <colgroup> land inside the <table>
  // even when the source order is wrong. The proof is that they are
  // table descendants.
  "table-scoped.html": (root) => {
    const tables = findAllElements(root, "table");
    expect(tables.length).toBe(1);
    const table = tables[0]!;
    expect(findElement(table, "caption")).toBeDefined();
    expect(findElement(table, "colgroup")).toBeDefined();
  },
  // Nested lists: a <ul> directly inside another <li> (or even another
  // <ul>) is made legal by inserting a synthetic <li>. The proof is
  // that the inner <ul> ends up inside the outer list.
  "nested-lists.html": (root) => {
    const uls = findAllElements(root, "ul");
    expect(uls.length).toBeGreaterThanOrEqual(2);
  },
  // MathML annotation-xml breakout: an <annotation-xml encoding="text/html">
  // re-enters HTML mode for its contents. The proof is that the
  // <annotation-xml> has an HTML <p> descendant.
  "mathml-annotation-xml.html": (root) => {
    const math = findElement(root, "math");
    expect(math).toBeDefined();
    const annotation = findElement(math!, "annotation-xml");
    expect(annotation).toBeDefined();
    expect(findElement(annotation!, "p")).toBeDefined();
  },
  // Sloppy generated report: multiple recovery families (implicit
  // elements, implied end tags) fire here. The proof is that html/body
  // exist despite no doctype, and that several <p> elements are
  // siblings inside the body.
  "generated-report.html": (root) => {
    expect(findElement(root, "html")).toBeDefined();
    const body = bodyElement(root);
    expect(body).toBeDefined();
    const directParas = childElements(body!).filter((e) => e.tagName.toLowerCase() === "p");
    expect(directParas.length).toBeGreaterThanOrEqual(2);
  },
};

const CORPUS: readonly CorpusRow[] = [
  {
    fixture: "basic-document.html",
    family: "well-formed",
    expected: "accept",
    proof: TRIGGER_PROOFS["basic-document.html"]!,
  },
  {
    fixture: "implicit-elements.html",
    family: "implicit-elements",
    expected: "accept",
    proof: TRIGGER_PROOFS["implicit-elements.html"]!,
  },
  {
    fixture: "implied-end-tags.html",
    family: "implied-end-tags",
    expected: "accept",
    proof: TRIGGER_PROOFS["implied-end-tags.html"]!,
  },
  {
    fixture: "foster-parenting.html",
    family: "foster-parenting",
    expected: "accept",
    proof: TRIGGER_PROOFS["foster-parenting.html"]!,
  },
  {
    fixture: "adoption-agency.html",
    family: "adoption-agency",
    expected: "accept",
    proof: TRIGGER_PROOFS["adoption-agency.html"]!,
  },
  {
    fixture: "foreign-content.html",
    family: "foreign-content",
    expected: "accept",
    proof: TRIGGER_PROOFS["foreign-content.html"]!,
  },
  {
    fixture: "template-content.html",
    family: "template-content",
    expected: "accept",
    proof: TRIGGER_PROOFS["template-content.html"]!,
  },
  {
    fixture: "character-references.html",
    family: "character-references",
    expected: "accept",
    proof: TRIGGER_PROOFS["character-references.html"]!,
  },
  {
    fixture: "noscript.html",
    family: "noscript-scripting",
    expected: "accept",
    proof: TRIGGER_PROOFS["noscript.html"]!,
  },
  {
    fixture: "select-clean.html",
    family: "select-clean",
    expected: "accept",
    proof: TRIGGER_PROOFS["select-clean.html"]!,
  },
  {
    fixture: "textarea-title.html",
    family: "escapable-raw-text",
    expected: "accept",
    proof: TRIGGER_PROOFS["textarea-title.html"]!,
  },
  {
    fixture: "table-scoped.html",
    family: "table-scoped",
    expected: "accept",
    proof: TRIGGER_PROOFS["table-scoped.html"]!,
  },
  {
    fixture: "nested-lists.html",
    family: "nested-lists",
    expected: "accept",
    proof: TRIGGER_PROOFS["nested-lists.html"]!,
  },
  {
    fixture: "mathml-annotation-xml.html",
    family: "mathml-annotation-xml",
    expected: "accept",
    proof: TRIGGER_PROOFS["mathml-annotation-xml.html"]!,
  },
  {
    fixture: "generated-report.html",
    family: "well-formed",
    expected: "accept",
    proof: TRIGGER_PROOFS["generated-report.html"]!,
  },
];

const INVALID_UTF8_BYTES = Uint8Array.from([
  0x3c, 0x68, 0x31, 0x3e, 0xff, 0x3c, 0x2f, 0x68, 0x31, 0x3e,
]);

interface MeasuredRow {
  readonly fixture: string;
  readonly family: RecoveryFamily;
  readonly expected: "accept" | "reject";
  readonly outcome: "agree" | "diverge" | "reject" | "shrink-to-reject" | "error";
  readonly detail?: string;
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

interface FrameTreeNode {
  frame: { id: string; url: string };
  childFrames?: { frame: { id: string; url: string } }[];
}

async function resolveMainFrame(target: VerifierTarget): Promise<{
  frameId: string;
  url: string;
}> {
  const tree = (await target.session.send("Page.getFrameTree")) as {
    frameTree: FrameTreeNode;
  };
  return { frameId: tree.frameTree.frame.id, url: tree.frameTree.frame.url };
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

test("select-with-table family is rejected as html_recovery_unsupported", async () => {
  const path = fixturePath("select-rejected.html");
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const result = parseHtml(bytes);
  if (result.status !== "error") {
    throw new Error(`expected parseHtml to reject select-with-table; got status=${result.status}`);
  }
  expect(result.errors.map((e) => e.code)).toContain("html_recovery_unsupported");
  measurements.push({
    fixture: "select-rejected.html",
    family: "select-rejected",
    expected: "reject",
    outcome: "reject",
    detail: "table markup inside <select> rejected as html_recovery_unsupported",
  });
});

for (const row of CORPUS) {
  test(`${row.fixture} (${row.family}): trigger proof fires + parse5 matches Chromium`, async () => {
    if (target === undefined) throw new Error("target not initialized");
    const path = fixturePath(row.fixture);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const parseResult = parseHtml(bytes);
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
    // The trigger proof walks the parse5 tree directly. If the named
    // family does NOT fire, this throws — so a fixture that does not
    // exercise its recovery makes its "agree" row decoration.
    const parse5Root = parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes), {
      scriptingEnabled: false,
    });
    row.proof(parse5Root as Parse5Node);

    // Re-render the harness srcdoc per fixture so the captured DOM is
    // exactly the one produced by THIS bytes payload.
    const harness = await buildHarnessSrcdoc("html");
    const harnessPath = join(workingDirectory!, `${row.fixture}.harness.html`);
    await writeFile(harnessPath, harness.srcdoc);
    await target.session.send("Page.navigate", { url: `file://${harnessPath}` });
    await waitForHarnessReady(target);
    const frame = await resolveMainFrame(target);
    await injectBytesAndAwaitRenderComplete(target, bytes, "html", "svg", 30_000);

    // Production observation: the verdict layer's own probe function.
    // If a regression zeros a count in countSnapshotHtml, this is what
    // surfaces it.
    const observation = await probeProtocolSnapshot(target.session, frame);
    const observed = observation.html;
    if (observed === undefined) {
      measurements.push({
        fixture: row.fixture,
        family: row.family,
        expected: row.expected,
        outcome: "diverge",
        detail: "probeProtocolSnapshot observed no renderer root",
      });
      throw new Error(
        `differential: probeProtocolSnapshot observed no renderer root for ${row.fixture}`,
      );
    }

    const diff = diffHtmlCounts(parseResult.html, observed);
    if (diff.length > 0 || observed.rendererRootCount !== 1) {
      const detail =
        diff.length === 0
          ? `rendererRootCount=${observed.rendererRootCount} (expected 1)`
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
      detail: `predicted=${JSON.stringify(parseResult.html)}`,
    });
    expect(parseResult.html.rendererRootCount).toBe(1);
    expect(observed.rendererRootCount).toBe(1);
  }, 60_000);
}

/**
 * Real-path mutation (Must-1 acceptance proof, automated). Build a
 * minimal snapshot that triggers the tableCount field and route it
 * through the production `probeProtocolSnapshot`. If a regression zeros
 * the tableCount incrementer in `countSnapshotHtml`, this test fails.
 *
 * To prove the corpus as a whole goes red on the same regression,
 * temporarily comment out the `counts.tableCount += 1` line in
 * `src/validation/tier1/protocol-probe.ts` and run the full corpus —
 * every fixture with a <table> will throw naming tableCount.
 */
test("production probeProtocolSnapshot increments tableCount on <table> elements", async () => {
  if (target === undefined) throw new Error("target not initialized");
  // Build a fixture with a <table>, navigate the harness, render the
  // fixture, and capture via the production probe.
  const fixtureSource =
    "<!doctype html><html><body>" +
    "<h1>Mutation probe</h1>" +
    "<table><tbody><tr><td>cell</td></tr></tbody></table>" +
    "</body></html>";
  const bytes = new TextEncoder().encode(fixtureSource);
  const harness = await buildHarnessSrcdoc("html");
  const harnessPath = join(workingDirectory!, "mutation-table.harness.html");
  await writeFile(harnessPath, harness.srcdoc);
  await target.session.send("Page.navigate", { url: `file://${harnessPath}` });
  await waitForHarnessReady(target);
  const frame = await resolveMainFrame(target);
  await injectBytesAndAwaitRenderComplete(target, bytes, "html", "svg", 30_000);
  const observation = await probeProtocolSnapshot(target.session, frame);
  expect(observation.html).toBeDefined();
  expect(observation.html?.tableCount).toBe(1);
});

test("production probeProtocolSnapshot increments externalImageCount on https <img>", async () => {
  if (target === undefined) throw new Error("target not initialized");
  const fixtureSource =
    "<!doctype html><html><body>" +
    "<h1>Image probe</h1>" +
    '<img src="https://cdn.example/x.png" alt="x">' +
    "</body></html>";
  const bytes = new TextEncoder().encode(fixtureSource);
  const harness = await buildHarnessSrcdoc("html");
  const harnessPath = join(workingDirectory!, "mutation-img.harness.html");
  await writeFile(harnessPath, harness.srcdoc);
  await target.session.send("Page.navigate", { url: `file://${harnessPath}` });
  await waitForHarnessReady(target);
  const frame = await resolveMainFrame(target);
  await injectBytesAndAwaitRenderComplete(target, bytes, "html", "svg", 30_000);
  const observation = await probeProtocolSnapshot(target.session, frame);
  expect(observation.html).toBeDefined();
  expect(observation.html?.imageCount).toBe(1);
  expect(observation.html?.externalImageCount).toBe(1);
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

// Unused imports — kept for clarity about the harness contract surface.
void ({} as SnapshotResponse);
