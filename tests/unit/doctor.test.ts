import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { parseArgs, renderHelp } from "../../src/cli/parser";
import {
  DOCTOR_PROBE_NAMES,
  runDoctor,
  type DoctorProbeResult,
} from "../../src/cli/commands/doctor";
import { DoctorResultSchema } from "../../src/shared/contracts/commands/results";
import { CURRENT_STORAGE_VERSION } from "../../src/shared/storage-version";

function makeEntrypoint(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  return path;
}

describe("doctor parser contract", () => {
  test("doctor is a local verb with help and no service command mapping", () => {
    expect(parseArgs(["doctor"])).toMatchObject({ kind: "verb", verb: "doctor", args: {} });
    expect(parseArgs(["doctor", "--json"])).toMatchObject({
      kind: "verb",
      verb: "doctor",
      jsonFlag: true,
    });
    expect(parseArgs(["doctor", "--help"])).toMatchObject({ kind: "help", verb: "doctor" });
    expect(renderHelp("doctor" as never)).toContain("facet doctor");
    const topLevelHelp = renderHelp();
    expect(topLevelHelp).toContain("doctor");
    expect(topLevelHelp).toMatch(/\b1\s+doctor/i);
  });
});

describe("doctor probe matrix", () => {
  test("checks Bun against the package minimum using semantic versions", () => {
    const options = {
      paths: {
        database: "/tmp/facet.sqlite",
        evidence: "/tmp/evidence",
        token: "/tmp/promote.token",
        lock: "/tmp/lock",
        metadata: "/tmp/meta",
      },
      shellBinary: "/tmp/chrome",
      netns: { available: true, reason: null },
      fs: {
        exists: () => true,
        stat: (path: string) => ({ mode: path === "/tmp/evidence" ? 0o100700 : 0o100600 }),
      },
      databaseReader: () => ({ quickCheck: "ok", version: CURRENT_STORAGE_VERSION }),
      lockReader: () => null,
      pidAlive: () => false,
      lockStale: () => false,
    };
    const cases = [
      ["1.3.14", "warn"],
      ["1.4.0", "pass"],
      ["1.4.2", "pass"],
      ["1.10.0", "pass"],
      ["2.0.0", "pass"],
      ["1.4.0-canary.1", "warn"],
    ] as const;

    for (const [bunVersion, status] of cases) {
      const bunProbe = runDoctor({ ...options, bunVersion }).probes.find(
        (probe) => probe.name === "bun",
      );
      expect(bunProbe?.status, bunVersion).toBe(status);
      expect(bunProbe?.details.expected, bunVersion).toBe(packageJson.engines.bun.slice(2));
      if (status === "warn") {
        expect(bunProbe?.fixCommand, bunVersion).toContain(
          `bun-v${packageJson.engines.bun.slice(2)}`,
        );
      }
      if (bunVersion === "1.3.14") {
        expect(bunProbe?.summary).toBe(
          "1.3.14 is below the supported minimum 1.4.0 (package engines)",
        );
      }
    }
  });

  test("Bun warning passes overall health unless another probe fails", () => {
    const options = {
      bunVersion: "1.3.14",
      paths: {
        database: "/tmp/facet.sqlite",
        evidence: "/tmp/evidence",
        token: "/tmp/promote.token",
        lock: "/tmp/lock",
        metadata: "/tmp/meta",
      },
      shellBinary: "/tmp/chrome",
      netns: { available: true, reason: null },
      fs: {
        exists: () => true,
        stat: (path: string) => ({ mode: path === "/tmp/evidence" ? 0o100700 : 0o100600 }),
      },
      databaseReader: () => ({ quickCheck: "ok", version: CURRENT_STORAGE_VERSION }),
      lockReader: () => null,
      pidAlive: () => false,
      lockStale: () => false,
    };
    const warningOnly = runDoctor(options);
    expect(warningOnly.probes.find((probe) => probe.name === "bun")?.status).toBe("warn");
    expect(warningOnly.allPassed).toBe(true);
    expect(DoctorResultSchema.safeParse(warningOnly).success).toBe(true);

    const warningWithDatabaseFailure = runDoctor({
      ...options,
      fs: { ...options.fs, exists: (path: string) => path !== options.paths.database },
    });
    expect(warningWithDatabaseFailure.probes.find((probe) => probe.name === "bun")?.status).toBe(
      "warn",
    );
    expect(
      warningWithDatabaseFailure.probes.find((probe) => probe.name === "database")?.status,
    ).toBe("fail");
    expect(warningWithDatabaseFailure.allPassed).toBe(false);
  });

  test("reports all seven probes and fails a missing database without creating it", () => {
    const database = "/tmp/facet-doctor-missing.sqlite";
    const result = runDoctor({
      bunVersion: "1.4.0",
      argv: ["bun", join(process.cwd(), "src/cli/main.ts"), "doctor"],
      which: () => null,
      paths: {
        database,
        evidence: "/tmp/facet-evidence",
        token: "/tmp/facet-promote.token",
        lock: "/tmp/facet.lock",
        metadata: "/tmp/facet-metadata.json",
      },
      shellBinary: "/tmp/chrome-headless-shell",
      netns: { available: true, reason: null },
      fs: {
        exists: () => false,
        stat: () => ({ mode: 0o100600 }),
      },
      databaseReader: () => ({ quickCheck: "ok", version: 9 }),
      lockReader: () => null,
      pidAlive: () => false,
      lockStale: () => false,
    });

    expect(result.probes.map((probe) => probe.name)).toEqual([...DOCTOR_PROBE_NAMES]);
    expect(result.allPassed).toBe(false);
    expect(result.probes.find((probe) => probe.name === "database")).toMatchObject({
      status: "fail",
      fixCommand: `bun '${join(process.cwd(), "src/cli/main.ts")}' status --start`,
    });
    expect(DoctorResultSchema.parse(result)).toMatchObject(result);
  });

  test("dormant service lock state passes while stale and cross-version locks fail", () => {
    const base = {
      bunVersion: "1.4.0",
      paths: {
        database: "/tmp/facet.sqlite",
        evidence: "/tmp/evidence",
        token: "/tmp/promote.token",
        lock: "/tmp/facet.lock",
        metadata: "/tmp/meta",
      },
      shellBinary: "/tmp/chrome",
      netns: { available: true, reason: null },
      fs: {
        exists: (path: string) => path !== "/tmp/facet.lock",
        stat: () => ({ mode: 0o100700 }),
      },
      databaseReader: () => ({ quickCheck: "ok", version: 9 }),
      pidAlive: () => true,
      lockStale: () => false,
    };
    const dormant = runDoctor({ ...base, lockReader: () => null });
    expect(dormant.probes.find((probe) => probe.name === "service-lock")).toMatchObject({
      status: "pass",
    });

    const stale = runDoctor({
      ...base,
      lockReader: () => ({ pid: 12, startTime: 0, port: 1, contractVersion: "facet-v1" }),
      lockStale: () => true,
    });
    expect(stale.probes.find((probe) => probe.name === "service-lock")).toMatchObject({
      status: "fail",
      fixCommand: expect.any(String),
    });
  });

  test("every failing probe has a literal repair command", () => {
    const result = runDoctor({
      bunVersion: "1.3.0",
      paths: {
        database: "/tmp/no-db",
        evidence: "/tmp/no-evidence",
        token: "/tmp/token",
        lock: "/tmp/lock",
        metadata: "/tmp/meta",
      },
      shellBinary: null,
      netns: { available: false, reason: "unshare exited with code 1" },
      fs: { exists: () => false, stat: () => ({ mode: 0o100644 }) },
      databaseReader: () => ({ quickCheck: "ok", version: 8 }),
      lockReader: () => null,
      pidAlive: () => false,
      lockStale: () => false,
    });
    for (const probe of result.probes as readonly DoctorProbeResult[]) {
      if (probe.status === "fail") expect(probe.fixCommand).toEqual(expect.any(String));
    }
  });

  test("uses the canonical storage version for current and stale databases", () => {
    let version = CURRENT_STORAGE_VERSION;
    const result = runDoctor({
      bunVersion: "1.4.0",
      paths: {
        database: "/tmp/facet.sqlite",
        evidence: "/tmp/evidence",
        token: "/tmp/secrets/promote.token",
        lock: "/tmp/lock",
        metadata: "/tmp/meta",
      },
      shellBinary: "/tmp/chrome",
      netns: { available: true, reason: null },
      fs: { exists: () => true, stat: () => ({ mode: 0o100700 }) },
      databaseReader: () => ({ quickCheck: "ok", version }),
      lockReader: () => null,
      pidAlive: () => false,
      lockStale: () => false,
    });
    const current = result.probes.find((probe) => probe.name === "database");
    expect(current).toMatchObject({ status: "pass" });
    expect(current?.details.version).toBe(CURRENT_STORAGE_VERSION);

    version = CURRENT_STORAGE_VERSION - 1;
    const stale = runDoctor({
      bunVersion: "1.4.0",
      paths: {
        database: "/tmp/facet.sqlite",
        evidence: "/tmp/evidence",
        token: "/tmp/secrets/promote.token",
        lock: "/tmp/lock",
        metadata: "/tmp/meta",
      },
      shellBinary: "/tmp/chrome",
      netns: { available: true, reason: null },
      fs: { exists: () => true, stat: () => ({ mode: 0o100700 }) },
      databaseReader: () => ({ quickCheck: "ok", version }),
      lockReader: () => null,
      pidAlive: () => false,
      lockStale: () => false,
    });
    expect(stale.probes.find((probe) => probe.name === "database")).toMatchObject({
      status: "fail",
      details: { expected: CURRENT_STORAGE_VERSION },
    });
  });

  test("uses facet only when PATH resolves to the active package entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "facet doctor prefix "));
    try {
      const installedEntrypoint = makeEntrypoint(
        join(root, "global", "node_modules", "@legionworks", "facet", "src", "cli", "main.ts"),
      );
      const otherEntrypoint = makeEntrypoint(
        join(root, "other", "node_modules", "@legionworks", "facet", "src", "cli", "main.ts"),
      );
      const localEntrypoint = makeEntrypoint(
        join(root, "consumer", "node_modules", "@legionworks", "facet", "src", "cli", "main.ts"),
      );
      const sourceEntrypoint = makeEntrypoint(join(root, "checkout", "src", "cli", "main.ts"));
      const binDirectory = join(root, "bin");
      mkdirSync(binDirectory);
      const facetBin = join(binDirectory, "facet");
      symlinkSync(installedEntrypoint, facetBin);

      const options = {
        bunVersion: "1.4.0",
        paths: {
          database: "/tmp/facet.sqlite",
          evidence: "/tmp/evidence",
          token: "/tmp/secrets/promote.token",
          lock: "/tmp/lock",
          metadata: "/tmp/meta",
        },
        shellBinary: "/tmp/chrome",
        netns: { available: true, reason: null },
        fs: {
          exists: () => false,
          stat: () => {
            throw new Error("missing");
          },
        },
        databaseReader: () => ({ quickCheck: "ok", version: CURRENT_STORAGE_VERSION }),
        lockReader: () => ({ pid: 12, startTime: 0, port: 1, contractVersion: "facet.v1" }),
        pidAlive: () => false,
        lockStale: () => true,
      };
      const fixCommand = (entrypoint: string, which: (command: string) => string | null) =>
        runDoctor({ ...options, argv: ["bun", entrypoint, "doctor"], which }).probes.find(
          (probe) => probe.name === "database",
        )?.fixCommand;

      expect(fixCommand(installedEntrypoint, () => facetBin)).toBe("facet status --start");
      expect(fixCommand(localEntrypoint, () => null)).toBe(
        `bun '${localEntrypoint}' status --start`,
      );
      expect(fixCommand(installedEntrypoint, () => otherEntrypoint)).toBe(
        `bun '${installedEntrypoint}' status --start`,
      );
      expect(fixCommand(sourceEntrypoint, () => facetBin)).toBe(
        `bun '${sourceEntrypoint}' status --start`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses resolved XDG and FACET_HOME paths for permission repair commands", () => {
    const cases = [
      {
        name: "XDG default",
        paths: {
          database: "/home/test/.local/share/facet/db/facet.sqlite",
          evidence: "/home/test/.local/state/facet/evidence",
          token: "/home/test/.local/share/facet/secrets/promote.token",
          lock: "/home/test/.local/state/facet/run/facet.lock",
          metadata: "/home/test/.config/facet/metadata.json",
        },
      },
      {
        name: "explicit FACET_HOME",
        paths: {
          database: "/tmp/facet home/db/facet.sqlite",
          evidence: "/tmp/facet home/evidence",
          token: "/tmp/facet home/secrets/promote.token",
          lock: "/tmp/facet home/run/facet.lock",
          metadata: "/tmp/facet home/metadata.json",
        },
      },
    ];

    for (const { name, paths } of cases) {
      const result = runDoctor({
        bunVersion: "1.4.0",
        argv: ["/usr/local/bin/facet", "doctor"],
        paths,
        shellBinary: "/tmp/chrome",
        netns: { available: true, reason: null },
        fs: {
          exists: () => true,
          stat: () => ({ mode: 0o100644 }),
        },
        databaseReader: () => ({ quickCheck: "ok", version: CURRENT_STORAGE_VERSION }),
        lockReader: () => null,
        pidAlive: () => false,
        lockStale: () => false,
      });
      const evidenceFix = result.probes.find((probe) => probe.name === "evidence-permissions");
      const tokenFix = result.probes.find((probe) => probe.name === "token-permissions");

      expect(evidenceFix?.fixCommand, name).toBe(`chmod 700 '${paths.evidence}'`);
      expect(tokenFix?.fixCommand, name).toBe(
        `chmod 600 '${paths.token.replace(/promote\.token$/, "install.token")}' '${paths.token}'`,
      );
      expect(evidenceFix?.fixCommand).not.toContain("$FACET_HOME");
      expect(tokenFix?.fixCommand).not.toContain("$FACET_HOME");
    }
  });

  test("uses status-start to create a missing evidence root", () => {
    const result = runDoctor({
      bunVersion: "1.4.0",
      argv: ["bun", join(process.cwd(), "src/cli/main.ts"), "doctor"],
      which: () => null,
      paths: {
        database: "/home/test/.local/share/facet/db/facet.sqlite",
        evidence: "/home/test/.local/state/facet/evidence",
        token: "/home/test/.local/share/facet/secrets/promote.token",
        lock: "/home/test/.local/state/facet/run/facet.lock",
        metadata: "/home/test/.config/facet/metadata.json",
      },
      shellBinary: "/tmp/chrome",
      netns: { available: true, reason: null },
      fs: {
        exists: () => false,
        stat: () => {
          throw new Error("missing");
        },
      },
      databaseReader: () => ({ quickCheck: "ok", version: CURRENT_STORAGE_VERSION }),
      lockReader: () => null,
      pidAlive: () => false,
      lockStale: () => false,
    });

    expect(result.probes.find((probe) => probe.name === "evidence-permissions")?.fixCommand).toBe(
      `bun '${join(process.cwd(), "src/cli/main.ts")}' status --start`,
    );
  });

  test("printed permission commands repair the real evidence and token modes", () => {
    const root = mkdtempSync(join(tmpdir(), "facet doctor repair "));
    try {
      const evidence = join(root, "evidence");
      const secrets = join(root, "secrets");
      const installToken = join(secrets, "install.token");
      const promoteToken = join(secrets, "promote.token");
      mkdirSync(evidence, { mode: 0o755 });
      mkdirSync(secrets, { mode: 0o755 });
      writeFileSync(installToken, "install", { mode: 0o644 });
      writeFileSync(promoteToken, "promote", { mode: 0o644 });

      const result = runDoctor({
        bunVersion: "1.4.0",
        argv: ["/usr/local/bin/facet", "doctor"],
        paths: {
          database: join(root, "db", "facet.sqlite"),
          evidence,
          token: promoteToken,
          lock: join(root, "run", "facet.lock"),
          metadata: join(root, "metadata.json"),
        },
        shellBinary: "/tmp/chrome",
        netns: { available: true, reason: null },
        fs: {
          exists: (path) => path === installToken || path === promoteToken,
          stat: (path) => statSync(path),
        },
        databaseReader: () => ({ quickCheck: "ok", version: CURRENT_STORAGE_VERSION }),
        lockReader: () => null,
        pidAlive: () => false,
        lockStale: () => false,
      });
      const evidenceFix = result.probes.find(
        (probe) => probe.name === "evidence-permissions",
      )?.fixCommand;
      const tokenFix = result.probes.find(
        (probe) => probe.name === "token-permissions",
      )?.fixCommand;

      expect(evidenceFix).toBe(`chmod 700 '${evidence}'`);
      expect(tokenFix).toBe(`chmod 600 '${installToken}' '${promoteToken}'`);
      execFileSync("sh", ["-c", evidenceFix!]);
      execFileSync("sh", ["-c", tokenFix!]);

      expect(statSync(evidence).mode & 0o777).toBe(0o700);
      expect(statSync(installToken).mode & 0o777).toBe(0o600);
      expect(statSync(promoteToken).mode & 0o777).toBe(0o600);

      chmodSync(installToken, 0o644);
      rmSync(promoteToken);
      const missingPromote = runDoctor({
        bunVersion: "1.4.0",
        argv: ["/usr/local/bin/facet", "doctor"],
        paths: {
          database: join(root, "db", "facet.sqlite"),
          evidence,
          token: promoteToken,
          lock: join(root, "run", "facet.lock"),
          metadata: join(root, "metadata.json"),
        },
        shellBinary: "/tmp/chrome",
        netns: { available: true, reason: null },
        fs: {
          exists: (path) => path === installToken,
          stat: (path) => statSync(path),
        },
        databaseReader: () => ({ quickCheck: "ok", version: CURRENT_STORAGE_VERSION }),
        lockReader: () => null,
        pidAlive: () => false,
        lockStale: () => false,
      });
      const installOnlyFix = missingPromote.probes.find(
        (probe) => probe.name === "token-permissions",
      )?.fixCommand;

      expect(installOnlyFix).toBe(`chmod 600 '${installToken}'`);
      expect(() => execFileSync("sh", ["-c", installOnlyFix!])).not.toThrow();
      expect(statSync(installToken).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
