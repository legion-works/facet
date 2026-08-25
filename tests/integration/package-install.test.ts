import { expect, test } from "bun:test";

const enabled = process.env.FACET_RUN_PACKAGE_INSTALL === "1";

test.skipIf(!enabled)("packed package passes the installed-consumer E2E", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/verify-package-install.ts"], {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  expect(await proc.exited).toBe(0);
});
