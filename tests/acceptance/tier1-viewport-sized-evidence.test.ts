import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { publishFixture } from "../helpers/facet-testkit";

async function publishSource(source: string, artifactType: "html" | "tsx", slug: string) {
  const directory = mkdtempSync(join(tmpdir(), "facet-tier1-viewport-evidence-"));
  const fixturePath = join(directory, `artifact.${artifactType}`);
  writeFileSync(fixturePath, source);
  try {
    return await publishFixture({
      fixturePath,
      artifactType,
      ...(artifactType === "tsx" ? { execution: "interactive" as const } : {}),
      slug,
      productionTier0: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// CI uploads this directory for this leg, so a pixel failure on a runner can be
// inspected instead of guessed at.
const EVIDENCE_DIR = join(process.cwd(), "test-results", "tier1-viewport-sized");

function keepEvidence(path: string, label: string) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  copyFileSync(path, join(EVIDENCE_DIR, `${label}.webp`));
}

function expectColor(actual: number[], expected: number[]) {
  for (let channel = 0; channel < 3; channel += 1)
    expect(Math.abs(actual[channel]! - expected[channel]!)).toBeLessThanOrEqual(48);
}

async function expectFullViewportImage(path: string, heroColor: number[], footerColor: number[]) {
  const image = sharp(readFileSync(path));
  const metadata = await image.metadata();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [
    ...data.subarray(
      (y * info.width + x) * info.channels,
      (y * info.width + x) * info.channels + 3,
    ),
  ];
  expect(metadata.format).toBe("webp");
  expect(metadata.pages ?? 1).toBe(1);
  expect(info.width).toBeGreaterThanOrEqual(1280);
  expect(info.height).toBeGreaterThanOrEqual(800 + 48);
  // Sample right of the fixtures' left-aligned text: host fonts differ in width,
  // and a runner font once put a glyph under a column-100 sample.
  const column = 1200;
  expectColor(pixel(column, 400), heroColor);
  expectColor(pixel(column, 790), heroColor);
  expectColor(pixel(column, 830), footerColor);
}

test("HTML viewport-height hero and following paragraph both appear in evidence", async () => {
  const published = await publishSource(
    '<!doctype html><html><body><div class="min-h-screen bg-red-500">Viewport-height hero</div><p class="m-0 p-4 bg-green-500">Content below the hero</p></body></html>',
    "html",
    "tier1-html-viewport-height",
  );
  expect(published.tier1Status).toBe("ok");
  expect(published.tier1ScreenshotError).toBeNull();
  expect(published.tier1ScreenshotPath).not.toBeNull();
  keepEvidence(published.tier1ScreenshotPath!, "html-viewport-height");
  await expectFullViewportImage(published.tier1ScreenshotPath!, [251, 44, 55], [0, 166, 62]);
}, 90_000);

test("interactive TSX viewport-height hero retains a still image including following content", async () => {
  const published = await publishSource(
    'import {useState} from "react"; export default function App(){const [clicks,setClicks]=useState(0); return <><div className="min-h-screen" style={{background:"#d53222"}} onClick={()=>setClicks(clicks+1)}>Viewport-height hero {clicks}</div><p style={{margin:0,height:96,background:"#22b97a"}}>Content below the hero</p></>}',
    "tsx",
    "tier1-interactive-viewport-height",
  );
  expect(published.tier1Status).toBe("ok");
  expect(published.tier1ScreenshotError).toBeNull();
  expect(published.tier1ScreenshotPath).not.toBeNull();
  keepEvidence(published.tier1ScreenshotPath!, "tsx-interactive-viewport-height");
  await expectFullViewportImage(published.tier1ScreenshotPath!, [213, 50, 34], [34, 185, 122]);
}, 90_000);

test("width-responsive interactive TSX retains evidence without a tiled fallback", async () => {
  const published = await publishSource(
    'import {useState} from "react"; export default function App(){const [selected,setSelected]=useState(0); const items=Array.from({length:60},(_,index)=>index);return <div style={{display:"flex",flexWrap:"wrap",width:"100%",gap:"8px",padding:"16px"}}>{items.map(index=><button key={index} onClick={()=>setSelected(index)} style={{width:"90px",height:"36px"}}>{selected===index?`Selected ${index}`:`Item ${index}`}</button>)}</div>}',
    "tsx",
    "tier1-width-responsive-interactive",
  );
  expect(published.tier1Status).toBe("ok");
  expect(published.tier1ScreenshotError).toBeNull();
  expect(published.tier1ScreenshotPath).not.toBeNull();
}, 90_000);

test("viewport-height content extending beyond 1280px retains its right edge", async () => {
  const published = await publishSource(
    'export default function App(){return <><div className="min-h-screen" style={{width:1800,background:"#d53222"}}>Wide hero</div><p style={{margin:0,height:96,background:"#22b97a"}}>Content below</p></>}',
    "tsx",
    "tier1-wide-viewport-height",
  );
  expect(published.tier1Status).toBe("ok");
  expect(published.tier1ScreenshotError).toBeNull();
  expect(published.tier1ScreenshotPath).not.toBeNull();
  keepEvidence(published.tier1ScreenshotPath!, "tsx-wide-viewport-height");
  const { data, info } = await sharp(readFileSync(published.tier1ScreenshotPath!))
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.width).toBeGreaterThan(1280);
  expect(info.height).toBeGreaterThan(800);
  const offset = (400 * info.width + 1500) * info.channels;
  expect(data[offset]).toBeGreaterThan(180);
  expect(data[offset + 1]).toBeLessThan(100);
}, 90_000);
