import { expect, test } from "bun:test";
import { resolve as resolvePath } from "node:path";

import { buildServiceSpawnArgs } from "../../src/cli/spawn-service";
import {
  buildTier0WorkerArgs,
  dispatchCompiledEntrypoint,
} from "../../src/runtime/compiled-entrypoints";
import type { FacetRuntimePaths } from "../../src/shared/config/paths";

const paths: FacetRuntimePaths = {
  database: "/tmp/facet/facet.db",
  evidence: "/tmp/facet/evidence",
  token: "/tmp/facet/promote.token",
  lock: "/tmp/facet/service.lock",
  metadata: "/tmp/facet/metadata.json",
};

test("dispatches the hidden compiled service role", async () => {
  let received: readonly string[] | undefined;

  expect(
    await dispatchCompiledEntrypoint(["--facet-internal-service", "--db-path", paths.database], {
      runService: async (argv) => {
        received = argv;
        return 0;
      },
    }),
  ).toBe(0);
  expect(received).toEqual(["--db-path", paths.database]);
});

test("dispatches the hidden compiled Tier 0 worker role", async () => {
  let runs = 0;

  expect(
    await dispatchCompiledEntrypoint(["--facet-internal-tier0-worker"], {
      runTier0Worker: async () => {
        runs += 1;
        return 0;
      },
    }),
  ).toBe(0);
  expect(runs).toBe(1);
});

test("leaves normal CLI argv undispatched", async () => {
  expect(await dispatchCompiledEntrypoint(["status"], {})).toBeNull();
});

test("builds compiled service and Tier 0 worker argv without source paths", () => {
  expect(buildServiceSpawnArgs(paths, { mode: "compiled" })[0]).toBe("--facet-internal-service");
  expect(buildTier0WorkerArgs({ mode: "compiled" })).toEqual(["--facet-internal-tier0-worker"]);
});

test("keeps source service and Tier 0 runner paths explicit", () => {
  const serviceArgs = buildServiceSpawnArgs(paths, {
    mode: "source",
    entrypoint: "/repo/src/service/main.ts",
    tier0RunnerPath: "/repo/src/validation/tier0/runner.ts",
    tier1RunnerPath: "/repo/src/validation/tier1/runner.ts",
  });

  expect(serviceArgs).toContain("/repo/src/service/main.ts");
  expect(serviceArgs).toContain("--tier0-runner-path");
  expect(serviceArgs).toContain("/repo/src/validation/tier0/runner.ts");
  expect(serviceArgs).toContain("--tier1-runner-path");
  expect(serviceArgs).toContain("/repo/src/validation/tier1/runner.ts");
  expect(buildTier0WorkerArgs({ mode: "source", entrypoint: "/repo/src/worker-entry.ts" })).toEqual(
    ["run", "/repo/src/worker-entry.ts"],
  );
});

test.each(["--facet-internal-service", "--facet-internal-tier0-worker"])(
  "source CLI rejects hidden compiled role %s as usage",
  async (role) => {
    const child = Bun.spawn([process.execPath, "src/cli/main.ts", role], {
      cwd: resolvePath(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();

    expect(await child.exited).toBe(64);
    expect(stdout).toContain(`Unknown verb: '${role}'`);
  },
);
