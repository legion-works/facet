import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildBrowserArgs, resolveLauncher } from "../../src/validation/tier1/launcher";

const scratch = join(tmpdir(), `facet-tier1-launcher-${crypto.randomUUID()}`);
const version = "test-version";
const binaryPath = join(scratch, version, "chrome-headless-shell-linux64", "chrome-headless-shell");
const wrapperPath = join(scratch, "launch-netns.sh");

mkdirSync(join(scratch, version, "chrome-headless-shell-linux64"), { recursive: true });
writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
chmodSync(binaryPath, 0o755);
writeFileSync(wrapperPath, "#!/bin/sh\nexit 0\n");
chmodSync(wrapperPath, 0o755);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("Tier 1 insecure launcher selection", () => {
  test("level 0 resolves the netns wrapper", () => {
    const launcher = resolveLauncher(0, { version, cacheRoot: scratch, wrapperPath });
    expect(launcher.executablePath).toBe(wrapperPath);
    expect(launcher.binaryPath).toBe(binaryPath);
  });

  test.each([1, 2, 3] as const)("level %d resolves the pinned shell directly", (level) => {
    const launcher = resolveLauncher(level, { version, cacheRoot: scratch, wrapperPath });
    expect(launcher.executablePath).toBe(binaryPath);
    expect(launcher.binaryPath).toBe(binaryPath);
  });

  test("the secure launcher keeps browser args and Chromium sandbox flags unchanged", () => {
    const args = buildBrowserArgs("/tmp/profile");
    expect(args).toContain("--headless=new");
    expect(args).not.toContain("--no-sandbox");
    expect(args).toEqual(buildBrowserArgs("/tmp/profile"));
  });
});
