import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTsxRuntimeEgressFixture, hostAddress } from "../../scripts/egress-penetration";
import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

test("a TSX alias that survives Tier 0 reaches the runtime no-egress boundary", async () => {
  const hits: string[] = [];
  const sink = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      hits.push(new URL(request.url).pathname);
      return new Response("unexpected egress");
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "facet-tsx-runtime-egress-"));
  try {
    const fixturePath = join(directory, "runtime-egress.tsx");
    await writeFile(fixturePath, buildTsxRuntimeEgressFixture(hostAddress(), sink.port ?? 0));
    const published = await publishFixture({
      fixturePath,
      artifactType: "tsx",
      execution: "interactive",
      slug: "tsx-runtime-egress",
      productionTier0: true,
    });
    const verdict = await readBackFixture({
      artifactId: published.artifactId,
      revisionSha: published.revisionSha,
      tier: 1,
      productionTier0: true,
    });

    expect({
      status: published.tier1Status,
      execution: verdict.execution,
      observed: verdict.observed,
      screenshotPath: published.tier1ScreenshotPath,
      screenshotError: published.tier1ScreenshotError,
      sentinelHits: hits,
    }).toEqual({
      status: "error",
      execution: "interactive",
      observed: expect.objectContaining({
        html: expect.objectContaining({ rendererRootCount: 1, headingCount: 1 }),
        errorCount: 1,
        discriminativeErrors: [expect.objectContaining({ code: "facet_error" })],
      }),
      screenshotPath: expect.any(String),
      screenshotError: null,
      sentinelHits: [],
    });
    expect(existsSync(published.tier1ScreenshotPath!)).toBe(true);
  } finally {
    sink.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
