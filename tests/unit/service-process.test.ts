import { describe, expect, test } from "bun:test";

import {
  runServiceProcess,
  type ServiceProcessHooks,
  type ServiceRunnerModules,
} from "../../src/service/process";
import type { StartServiceOptions } from "../../src/service/server";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve };
}

const tier0Runner = async () => {
  throw new Error("Tier 0 runner must not run during service startup");
};

const tier1Runner = async () => {
  throw new Error("Tier 1 runner must not run during service startup");
};

function modules(
  probes: {
    readonly tier0?: { readonly available: boolean; readonly reason: string | null };
    readonly tier1?: { readonly available: boolean; readonly reason: string | null };
  } = {},
): ServiceRunnerModules {
  return {
    tier0: {
      factory: () => tier0Runner,
      probe: () => probes.tier0 ?? { available: true, reason: null },
    },
    loadTier1: async () => ({
      factory: () => tier1Runner,
      probe: () => probes.tier1 ?? { available: true, reason: null },
    }),
  };
}

function serviceHooks(onStart: (options: StartServiceOptions) => Promise<void>): {
  readonly hooks: ServiceProcessHooks;
  readonly signals: Map<string, () => void>;
  readonly stderr: string[];
} {
  const signals = new Map<string, () => void>();
  const stderr: string[] = [];
  return {
    hooks: {
      onSignal: (signal, handler) => signals.set(signal, handler),
      writeStderr: (line) => stderr.push(line),
      startService: async (options) => {
        await onStart(options);
        return {
          port: 45123,
          pid: 123,
          url: "http://127.0.0.1:45123",
          installToken: "install",
          promoteToken: null,
          stop: async () => {},
          waitUntilIdle: async () => {},
        };
      },
    },
    signals,
    stderr,
  };
}

describe("runServiceProcess", () => {
  test("starts with parsed paths, announces readiness, then exits after idle", async () => {
    let received: StartServiceOptions | undefined;
    const seam = serviceHooks(async (options) => {
      received = options;
    });

    const exitCode = await runServiceProcess(
      [
        "--db-path",
        "/tmp/facet.sqlite",
        "--install-token-path",
        "/tmp/install.token",
        "--promote-token-path",
        "/tmp/promote.token",
        "--lock-path",
        "/tmp/facet.lock",
        "--evidence-path",
        "/tmp/evidence",
        "--idle-timeout-ms",
        "250",
      ],
      {},
      async () => modules(),
      seam.hooks,
    );

    expect(exitCode).toBe(0);
    expect(received).toMatchObject({
      dbPath: "/tmp/facet.sqlite",
      installTokenPath: "/tmp/install.token",
      promoteTokenPath: "/tmp/promote.token",
      lockPath: "/tmp/facet.lock",
      evidencePath: "/tmp/evidence",
      idleTimeoutMs: 250,
      insecureLevel: 0,
      insecureReason: null,
    });
    const ready = JSON.parse(seam.stderr.at(-1) ?? "") as {
      event?: string;
      port?: number;
      url?: string;
    };
    expect(ready).toMatchObject({
      event: "service.ready",
      port: 45123,
      url: "http://127.0.0.1:45123",
    });
  });

  test("stops an active service when SIGTERM arrives", async () => {
    const stopped = deferred();
    const idle = deferred();
    const ready = deferred();
    const signals = new Map<string, () => void>();
    const hooks: ServiceProcessHooks = {
      onSignal: (signal, handler) => signals.set(signal, handler),
      writeStderr: (line) => {
        if (line.includes('"event":"service.ready"')) ready.resolve();
      },
      startService: async () => {
        return {
          port: 45123,
          pid: 123,
          url: "http://127.0.0.1:45123",
          installToken: "install",
          promoteToken: null,
          stop: async () => stopped.resolve(),
          waitUntilIdle: async () => idle.promise,
        };
      },
    };

    const running = runServiceProcess([], {}, async () => modules(), hooks);
    await ready.promise;
    signals.get("SIGTERM")?.();
    await stopped.promise;
    idle.resolve();

    expect(await running).toBe(0);
  });

  test.each([
    {
      name: "Tier 0 isolation is unavailable",
      probes: { tier0: { available: false, reason: "no namespace" } },
      level: 2,
      reason: "auto:no namespace",
    },
    {
      name: "Tier 1 browser is unavailable after Tier 0 succeeds",
      probes: {
        tier0: { available: true, reason: null },
        tier1: { available: false, reason: "Chrome absent" },
      },
      level: 1,
      reason: "auto:Chrome absent",
    },
  ])("uses insecure fallback level when $name", async ({ probes, level, reason }) => {
    let received: StartServiceOptions | undefined;
    const seam = serviceHooks(async (options) => {
      received = options;
    });

    expect(
      await runServiceProcess(
        [],
        { FACET_INSECURE_AUTO: "1" },
        async () => modules(probes),
        seam.hooks,
      ),
    ).toBe(0);
    expect(received).toMatchObject({ insecureLevel: level, insecureReason: reason });
    expect(seam.stderr[0]).toBe(`WARN: FACET_INSECURE=${level} — ${reason}\n`);
  });
});
