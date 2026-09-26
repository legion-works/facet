import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishFixture, readBackFixture } from "../helpers/facet-testkit";
import { parseMarkdown } from "../../src/validation/tier0/markdown";

test("Markdown read-back distinguishes non-empty prose from empty renderer roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "facet-markdown-tier1-"));
  try {
    const cases = [
      { name: "text", content: "Hello world.", expected: "ok", empty: false },
      { name: "empty", content: "\n", expected: "partial:layout_unverified", empty: true },
      {
        name: "whitespace",
        content: " \n\t\n",
        expected: "partial:layout_unverified",
        empty: true,
      },
      {
        name: "external",
        content: "![external](https://example.test/image.png)",
        expected: "partial:external_resources",
        empty: false,
      },
      {
        name: "http-external",
        content: "![external](http://example.test/image.png)",
        expected: "ok",
        empty: false,
      },
      {
        name: "mermaid",
        content: "```mermaid\nflowchart TD\n  A --> B\n```",
        expected: "ok",
        empty: false,
      },
      {
        name: "pipeline-audit",
        content: await Bun.file(join(import.meta.dir, "../../templates/pipeline-audit.md")).text(),
        expected: "ok",
        empty: false,
      },
    ] as const;

    for (const item of cases) {
      const fixturePath = join(directory, `${item.name}.md`);
      await writeFile(fixturePath, item.content, "utf8");
      const published = await publishFixture({
        fixturePath,
        artifactType: "markdown",
        slug: `markdown-tier1-${item.name}`,
        productionTier0: true,
      });
      const verdict = await readBackFixture({
        artifactId: published.artifactId,
        revisionSha: published.revisionSha,
        tier: 1,
        productionTier0: true,
      });
      const predicted = await parseMarkdown(new TextEncoder().encode(item.content));
      expect(verdict.observed.externalImageCount, item.name).toBe(
        predicted.observed.externalImageCount,
      );
      expect(verdict.observed.externalImageCount).toBe(item.name === "external" ? 1 : 0);
      expect(verdict.observed.emptyRendererRoot).toBe(item.empty);
      expect(verdict.observed.html).toBeUndefined();
      expect(verdict.status).toBe(item.expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
