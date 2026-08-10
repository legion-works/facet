/**
 * Valid command request/result factories for the contract tests. Kept in
 * a helper so each test file can import just the verbs it covers
 * without duplicating the constants.
 */

export const REQUEST_ID = "req-0001";

export const ARTIFACT = {
  id: "art-1",
  projectId: "project-1",
  slug: "my-artifact",
  title: "My artifact",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

export const REVISION = {
  id: "rev-1",
  artifactId: "art-1",
  revisionNumber: 1,
  parentRevisionId: null,
  artifactType: "markdown" as const,
  renderer: "svg" as const,
  sha256: "a".repeat(64),
  note: null,
  pinned: false,
  createdAt: "2025-01-01T00:00:00.000Z",
};

export const TEMPLATE = {
  id: "tpl-1",
  artifactId: "art-1",
  revisionId: "rev-1",
  name: "stable",
  description: null,
  promotedBy: "alice",
  promotedAt: "2025-01-01T00:00:00.000Z",
};

export const VERDICT_OBSERVED = {
  rendererRootSvgCount: 1,
  graphCount: 1,
  mermaidNodeCount: 2,
  visibleSvgCount: 1,
  errorCount: 0,
  opaqueRegionCount: 0,
  externalImageCount: 0,
};

export const HTML_STRUCTURE_COUNTS = {
  rendererRootCount: 1,
  headingCount: 0,
  tableCount: 0,
  listCount: 0,
  imageCount: 1,
  canvasCount: 0,
  externalImageCount: 1,
};

export function validCreateRequest() {
  return {
    command: "create" as const,
    requestId: REQUEST_ID,
    projectId: "project-1",
    slug: "my-artifact",
    title: "My artifact",
  };
}
export function validCreateResult() {
  return { command: "create" as const, requestId: REQUEST_ID, artifact: ARTIFACT };
}
export function validPublishRequest() {
  // Wire format is base64 (per D1 review) — "hi" → "aGk="
  return {
    command: "publish" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    artifactType: "markdown" as const,
    renderer: "svg" as const,
    bytes: "aGk=",
    note: null,
  };
}
export function validPublishResult() {
  return {
    command: "publish" as const,
    requestId: REQUEST_ID,
    revision: REVISION,
    tier1Verdict: null,
  };
}
export function validListRequest() {
  return { command: "list" as const, requestId: REQUEST_ID, projectId: "project-1" };
}
export function validListResult() {
  return { command: "list" as const, requestId: REQUEST_ID, artifacts: [ARTIFACT] };
}
export function validReadBackRequest() {
  return {
    command: "readBack" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionSha: "a".repeat(64),
    tier: 0 as const,
  };
}
export function validReadBackResult() {
  return {
    command: "readBack" as const,
    requestId: REQUEST_ID,
    renderer: "svg" as const,
    verdict: {
      status: "ok" as const,
      tier: 1 as const,
      artifactId: "art-1",
      revisionSha: "a".repeat(64),
      observed: VERDICT_OBSERVED,
    },
  };
}
export function validStatusRequest() {
  return { command: "status" as const, requestId: REQUEST_ID, artifactId: "art-1" };
}
export function validStatusResult() {
  return {
    command: "status" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionCount: 5,
    pinnedCount: 1,
    templateCount: 1,
  };
}
export function validOpenRequest() {
  return {
    command: "open" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionSha: "a".repeat(64),
  };
}
export function validOpenResult() {
  return {
    command: "open" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionSha: "a".repeat(64),
    frameUrl: "facet://frame/art-1/" + "a".repeat(64),
    lease: {
      leaseId: "lease-1",
      // Fixed timestamp so two `validOpenResult()` calls in the same
      // assertion produce the same value. `Date.now() + 60_000` here
      // made the round-trip test a millisecond-race: the parsed value
      // and the freshly built fixture could straddle a ms boundary and
      // disagree on `expiresAt`. Tests should not depend on wall-clock
      // state.
      expiresAt: 1_700_000_000_000,
    },
  };
}
export function validPromoteRequest() {
  return {
    command: "promote" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionId: "rev-1",
    name: "stable",
    promotedBy: "alice",
  };
}
export function validPromoteResult() {
  return { command: "promote" as const, requestId: REQUEST_ID, template: TEMPLATE };
}
export function validInstantiateRequest() {
  return {
    command: "instantiate" as const,
    requestId: REQUEST_ID,
    name: "stable",
    newSlug: "instantiated-artifact",
  };
}
export function validInstantiateResult() {
  return {
    command: "instantiate" as const,
    requestId: REQUEST_ID,
    artifact: { ...ARTIFACT, id: "art-2", slug: "instantiated-artifact", title: "stable" },
    template: TEMPLATE,
  };
}
export function validPinRequest() {
  return { command: "pin" as const, requestId: REQUEST_ID, revisionId: "rev-1", pinned: true };
}
export function validPinResult() {
  return { command: "pin" as const, requestId: REQUEST_ID, revisionId: "rev-1", pinned: true };
}

export function validExportRequest() {
  return {
    command: "export" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    format: "source" as const,
  };
}

export function validExportResult() {
  return {
    command: "export" as const,
    requestId: REQUEST_ID,
    format: "source" as const,
    bytes: "aGk=",
    sidecar: {
      artifactId: "art-1",
      slug: "my-artifact",
      revisionSha: "a".repeat(64),
      artifactType: "markdown" as const,
      renderer: "svg" as const,
      verdict: {
        status: "ok" as const,
        tier: 0 as const,
        artifactId: "art-1",
        revisionSha: "a".repeat(64),
        observed: VERDICT_OBSERVED,
      },
      format: "source" as const,
      exportedAt: "2025-01-01T00:00:00.000Z",
    },
  };
}
