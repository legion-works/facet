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

  expect(workflow).toMatch(/^  npm-publish:\n/m);
  expect(workflow).toMatch(/^    needs: release-please\n/m);
  expect(workflow).toMatch(/^    if: needs\.release-please\.outputs\.release_created == 'true'\n/m);
  expect(workflow).toMatch(/^      id-token: write\n/m);
  expect(workflow).toMatch(/^      contents: read\n/m);
  expect(workflow).toMatch(/^      NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}\n/m);
  expect(workflow).toMatch(
    /^      - name: publish package\n(?:(?!^      - name:).*\n)*?^        if: env\.NPM_TOKEN != ''\s*$/m,
  );
  expect(workflow).toMatch(/^        run: npm publish --provenance --access public\s*$/m);
  expect(workflow).toMatch(/^          NODE_AUTH_TOKEN: \$\{\{ env\.NPM_TOKEN \}\}\n/m);
  expect(workflow).toMatch(
    /^      - name: skip npm publish \(NPM_TOKEN is absent\)\n(?:(?!^      - name:).*\n)*?^        if: env\.NPM_TOKEN == ''\s*$/m,
  );
  expect(workflow).toMatch(/Skipping npm publish: NPM_TOKEN is not configured/);
});
