import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflowPath =
  process.env.FACET_RELEASE_WORKFLOW ??
  join(import.meta.dir, "../../.github/workflows/release.yml");

function releaseWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

test("publishes the scoped package only when NPM_TOKEN is provisioned", () => {
  const workflow = releaseWorkflow();
  const publishJob = workflow.match(/^  npm-publish:\n([\s\S]*)$/m)?.[1] ?? "";

  expect(workflow).toMatch(/^  npm-publish:\n/m);
  expect(workflow).toMatch(/^  assets:\n(?:(?!^  \S).*\n)*?^    needs: release-please\n/m);
  expect(publishJob).toMatch(/^    needs: assets\n/m);
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
  expect(publishJob).toMatch(/^          NODE_AUTH_TOKEN: \$\{\{ env\.NPM_TOKEN \}\}\n/m);
  expect(publishJob).toMatch(
    /^      - name: skip npm publish \(NPM_TOKEN is absent\)\n(?:(?!^      - name:).*\n)*?^        if: env\.NPM_TOKEN == ''\s*$/m,
  );
  expect(publishJob).toMatch(/Skipping npm publish: NPM_TOKEN is not configured/);
});
