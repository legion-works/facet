/**
 * Evidence path derivation + tolerant-read tests.
 *
 * Two contracts:
 *  1. The parent CLI and the spawned service child must agree on ONE
 *     evidence root. In XDG mode (no FACET_HOME), `computeFacetPaths`
 *     puts evidence under `<stateHome>/facet/evidence`, and the child's
 *     `--evidence-path` flag must carry exactly that path.
 *  2. Pre-threading default-XDG installs wrote evidence under the legacy
 *     child-derived root (`<dataHome>/facet/evidence`). Readers tolerate
 *     that divergence: when the canonical root is empty and the legacy
 *     root holds evidence, the legacy root is added as a read-only
 *     fallback. A populated canonical root never consults the legacy root.
 */

import { describe, expect, test } from "bun:test";

import { buildServiceSpawnArgs } from "../../src/cli/spawn-service";
import { resolveEvidenceReadRoots, type EvidenceFs } from "../../src/shared/config/evidence-read";
import { computeFacetPaths, legacyXdgEvidenceRoot } from "../../src/shared/config/paths";

const XDG_ENV = {
  xdgDataHome: "/data",
  xdgStateHome: "/state",
  xdgConfigHome: "/config",
};

function fakeFs(has: ReadonlySet<string>): EvidenceFs {
  return { hasEvidence: (path: string) => has.has(path) };
}

describe("computeFacetPaths — evidence root derivation", () => {
  test("XDG mode: evidence under stateHome, database under dataHome", () => {
    const paths = computeFacetPaths(XDG_ENV);
    expect(paths.database).toBe("/data/facet/db/facet.sqlite");
    expect(paths.evidence).toBe("/state/facet/evidence");
    expect(paths.lock).toBe("/state/facet/run/facet.lock");
    expect(paths.token).toBe("/data/facet/secrets/promote.token");
  });

  test("FACET_HOME mode: evidence under facetHome (unchanged)", () => {
    const paths = computeFacetPaths({ facetHome: "/home" });
    expect(paths.database).toBe("/home/db/facet.sqlite");
    expect(paths.evidence).toBe("/home/evidence");
  });
});

describe("legacyXdgEvidenceRoot", () => {
  test("XDG mode returns the child-derived dataHome root", () => {
    expect(legacyXdgEvidenceRoot(XDG_ENV)).toBe("/data/facet/evidence");
  });

  test("FACET_HOME mode returns null (never diverged)", () => {
    expect(legacyXdgEvidenceRoot({ facetHome: "/home" })).toBeNull();
  });
});

describe("buildServiceSpawnArgs — parent/child evidence-root agreement", () => {
  test("XDG mode: the child --evidence-path equals the parent's paths.evidence", () => {
    const paths = computeFacetPaths(XDG_ENV);
    const args = buildServiceSpawnArgs(paths, {
      entrypoint: "/srv/main.ts",
      tier0RunnerPath: "/srv/tier0.ts",
      tier1RunnerPath: "/srv/tier1.ts",
    });
    const evidenceIndex = args.indexOf("--evidence-path");
    expect(evidenceIndex).toBeGreaterThan(0);
    expect(args[evidenceIndex + 1]).toBe(paths.evidence);
    expect(args[evidenceIndex + 1]).toBe("/state/facet/evidence");
  });

  test("FACET_HOME mode: the child --evidence-path equals the facetHome evidence root", () => {
    const paths = computeFacetPaths({ facetHome: "/home" });
    const args = buildServiceSpawnArgs(paths, {
      entrypoint: "/srv/main.ts",
      tier0RunnerPath: "/srv/tier0.ts",
      tier1RunnerPath: "/srv/tier1.ts",
    });
    const evidenceIndex = args.indexOf("--evidence-path");
    expect(args[evidenceIndex + 1]).toBe("/home/evidence");
  });
});

describe("resolveEvidenceReadRoots — tolerant read fallback", () => {
  test("canonical empty + legacy populated → legacy root added as fallback", () => {
    const roots = resolveEvidenceReadRoots(
      "/state/facet/evidence",
      "/data/facet/evidence",
      fakeFs(new Set(["/data/facet/evidence"])),
    );
    expect(roots.map((r) => r.path)).toEqual(["/state/facet/evidence", "/data/facet/evidence"]);
    expect(roots[0]!.legacy).toBe(false);
    expect(roots[1]!.legacy).toBe(true);
  });

  test("canonical populated → legacy ignored", () => {
    const roots = resolveEvidenceReadRoots(
      "/state/facet/evidence",
      "/data/facet/evidence",
      fakeFs(new Set(["/state/facet/evidence", "/data/facet/evidence"])),
    );
    expect(roots.map((r) => r.path)).toEqual(["/state/facet/evidence"]);
  });

  test("legacy root null → canonical only", () => {
    const roots = resolveEvidenceReadRoots("/state/facet/evidence", null);
    expect(roots.map((r) => r.path)).toEqual(["/state/facet/evidence"]);
  });

  test("legacy equals canonical → no duplicate", () => {
    const roots = resolveEvidenceReadRoots("/same/evidence", "/same/evidence");
    expect(roots.map((r) => r.path)).toEqual(["/same/evidence"]);
  });
});
