import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { artifactWorld, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

/**
 * Two fences in one markdown artifact, rendered through the REAL
 * gallery service (`dist/gallery`, not the Tier 1 harness bundle).
 * The harness bundle never reproduced the defect this gates — its
 * `Bun.build` invocation is unaffected by the per-artifact-type
 * splitting the gallery build used to do. A flowchart is the
 * discriminator (its label carries no markdown-string content, just
 * plain bracket labels); a sequence diagram in the SAME document is
 * the control — it stayed correct even at the broken commit, so its
 * presence proves the assertion actually distinguishes fence content
 * rather than passing on any SVG existing at all.
 */
const markdownSource = [
  "# Status",
  "",
  "```mermaid",
  "flowchart TD",
  "  Start[Start] --> Middle[Middle step]",
  "  Middle --> Done[Done]",
  "  Middle --> Alt[Alternate]",
  "```",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  Alice->>Bob: Hello Bob",
  "  Bob-->>Alice: Hello Alice",
  "```",
].join("\n");

test("gallery keeps every Mermaid flowchart label inside a markdown fence", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-markdown-mermaid-labels-"));
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-markdown-mermaid-labels" }),
    tier0Runner: stubTier0Runner,
  });
  const browser = galleryBrowser();
  let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
  try {
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    target = await browser.launch();
    await navigateToArtifact(target, client, "markdown", markdownSource);
    const world = await artifactWorld(target);
    const result = (await target.session.send("Runtime.evaluate", {
      contextId: world,
      returnByValue: true,
      expression: `(() => {
        const svgs = Array.from(document.querySelectorAll('[data-facet-renderer-graph="true"]'));
        return svgs.map((svg) => ({
          labels: Array.from(svg.querySelectorAll('text'))
            .map((node) => (node.textContent || '').trim())
            .filter((text) => text.length > 0),
        }));
      })()`,
    })) as { result?: { value?: readonly { readonly labels: readonly string[] }[] } };
    const diagrams = result.result?.value;
    expect(diagrams).toHaveLength(2);
    // Flowchart — the defect's discriminator.
    expect(diagrams?.[0]?.labels).toEqual(
      expect.arrayContaining(["Start", "Middle step", "Done", "Alternate"]),
    );
    // Sequence diagram — the control; stayed correct even at the broken commit.
    expect(diagrams?.[1]?.labels.length).toBeGreaterThan(0);
  } finally {
    await target?.close();
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 45_000);
