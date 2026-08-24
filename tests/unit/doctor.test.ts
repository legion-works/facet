import { describe, expect, test } from "bun:test";

import { parseArgs, renderHelp } from "../../src/cli/parser";
import {
  DOCTOR_PROBE_NAMES,
  runDoctor,
  type DoctorProbeResult,
} from "../../src/cli/commands/doctor";
import { DoctorResultSchema } from "../../src/shared/contracts/commands/results";
import { CURRENT_STORAGE_VERSION } from "../../src/shared/storage-version";

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
  test("reports all seven probes and fails a missing database without creating it", () => {
    const database = "/tmp/facet-doctor-missing.sqlite";
    const result = runDoctor({
      bunVersion: "1.4.0",
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
      fixCommand: "facet status --start",
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
    let version = 9;
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
});
