import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ensureService } from "../../src/cli/spawn-service";
import { computeFacetPaths, type FacetRuntimePaths } from "../../src/shared/config/paths";
import { isPidAlive } from "../../src/shared/util/process";
import { stopProcess } from "./process";

const BUN_PATH = process.env.FACET_PERF_BUN ?? process.execPath;

export interface DetachedPerfService {
  readonly home: string;
  readonly paths: FacetRuntimePaths;
  readonly pid: number;
  readonly port: number;
  readonly baseUrl: string;
  readonly installToken: string;
}

export async function startDetachedPerfService(options: {
  readonly idleTimeoutMs: number;
}): Promise<DetachedPerfService> {
  const home = mkdtempSync(join(tmpdir(), "facet-perf-service-"));
  const paths = computeFacetPaths({ facetHome: home });
  const resolved = await ensureService({
    env: {
      ...process.env,
      FACET_HOME: home,
      PATH: `${dirname(BUN_PATH)}:${process.env.PATH ?? ""}`,
    },
    paths,
    bunPath: BUN_PATH,
    idleTimeoutMs: options.idleTimeoutMs,
  });
  return {
    home,
    paths,
    pid: resolved.metadata.pid,
    port: resolved.metadata.port,
    baseUrl: resolved.baseUrl,
    installToken: resolved.installToken,
  };
}

export async function inspectDormancy(service: DetachedPerfService): Promise<{
  readonly processExited: boolean;
  readonly portClosed: boolean;
  readonly lockRemoved: boolean;
}> {
  let portClosed = false;
  try {
    await fetch(`${service.baseUrl}/`, { signal: AbortSignal.timeout(200) });
  } catch {
    portClosed = true;
  }
  return {
    processExited: !isPidAlive(service.pid),
    portClosed,
    lockRemoved: !existsSync(service.paths.lock),
  };
}

export async function waitForDormancy(
  service: DetachedPerfService,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof inspectDormancy>>> {
  const deadline = Date.now() + timeoutMs;
  let observed = await inspectDormancy(service);
  while (
    !(observed.processExited && observed.portClosed && observed.lockRemoved) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(25);
    observed = await inspectDormancy(service);
  }
  return observed;
}

export async function stopDetachedProcess(pid: number): Promise<void> {
  await stopProcess(pid);
}
