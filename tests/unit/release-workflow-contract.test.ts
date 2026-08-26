import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflowPath =
  process.env.FACET_RELEASE_WORKFLOW ??
  join(import.meta.dir, "../../.github/workflows/release.yml");

function releaseWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

function workflowJob(workflow: string, name: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  if (start < 0) return "";
  const bodyStart = start + name.length + 3;
  const body = workflow.slice(bodyStart);
  const nextJob = body.search(/^  \S/m);
  return body.slice(0, nextJob < 0 ? body.length : nextJob);
}

test("publishes the scoped package only when NPM_TOKEN is provisioned", () => {
  const workflow = releaseWorkflow();
  const publishJob = workflowJob(workflow, "npm-publish");

  expect(workflow).toMatch(/^  npm-publish:\n/m);
  expect(workflow).toMatch(/^  assets:\n(?:(?!^  \S).*\n)*?^    needs: release-please\n/m);
  expect(publishJob).toMatch(/^    needs: \[assets, release-please\]\n/m);
  expect(publishJob).toMatch(
    /^    if: needs\.release-please\.outputs\.release_created == 'true'\n/m,
  );
  expect(publishJob).toMatch(/^      id-token: write\n/m);
  expect(publishJob).toMatch(/^      contents: read\n/m);
  expect(publishJob).toMatch(/^      NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}\n/m);
  expect(publishJob).toMatch(
    /^      - name: publish package\n(?:(?!^      - name:).*\n)*?^        if: env\.NPM_TOKEN != ''\s*$/m,
  );
  expect(publishJob).toMatch(/^        run: npm publish --provenance --access public\s*$/m);
  expect(publishJob).toMatch(/^          NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}\n/m);
  expect(publishJob).toMatch(
    /^      - name: skip npm publish \(NPM_TOKEN is absent\)\n(?:(?!^      - name:).*\n)*?^        if: env\.NPM_TOKEN == ''\s*$/m,
  );
  expect(publishJob).toMatch(/Skipping npm publish: NPM_TOKEN is not configured/);
});

test("configures npm authentication through setup-node", () => {
  const publishJob = workflowJob(releaseWorkflow(), "npm-publish");

  expect(publishJob).toMatch(
    /^      # v4\.4\.0 — 49933ea5288caeca8642d1e84afbd3f7d6820020\n      - uses: actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n        with:\n          registry-url: ['"]https:\/\/registry\.npmjs\.org['"]\s*$/m,
  );
  expect(publishJob).toMatch(
    /^      - name: publish package\n(?:(?!^      - name:).*\n)*?^          NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}\n/m,
  );
});

test("offers a tag-scoped npm publish retry dispatch", () => {
  const workflow = releaseWorkflow();
  const retryJob = workflowJob(workflow, "npm-publish-retry");

  expect(workflow).toMatch(
    /^  workflow_dispatch:\n    inputs:\n      tag:\n        description: Publish an existing release tag\n        required: true\n        type: string\s*$/m,
  );
  expect(retryJob).toMatch(/^    if: \$\{\{ inputs\.tag != '' \}\}\n/m);
  expect(retryJob).toContain("RELEASE_TAG: ${{ inputs.tag }}");
  expect(retryJob).toContain('TAG="$RELEASE_TAG"');
  expect(retryJob).toContain('if [[ ! "$TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
  expect(retryJob).toContain('git show-ref --tags --verify --quiet "refs/tags/$TAG"');
  expect(retryJob).toContain("PACKAGE_VERSION=$(node -p");
  expect(retryJob).toContain('if [[ "$PACKAGE_VERSION" != "${TAG#v}" ]]');
  expect(retryJob).toMatch(/actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/);
  expect(retryJob).toMatch(/git checkout --detach "\$TAG"/);
  expect(retryJob).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
});
