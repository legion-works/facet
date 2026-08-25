#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import packageJson from "../package.json" with { type: "json" };

type Envelope = { schemaVersion?: string; ok?: boolean; data?: Record<string, unknown> };

const repoRoot = resolve(import.meta.dir, "..");
const scratch = join(tmpdir(), `facet-package-install-${crypto.randomUUID()}`);
const consumer = join(scratch, "consumer");
const home = join(scratch, "facet-home");
const fixture = join(scratch, "source.md");
const exported = join(consumer, "exported.md");
const bun = process.execPath;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(args: readonly string[], options: { allowExit?: readonly number[] } = {}) {
  let promoteToken: string | undefined;
  try {
    promoteToken = readFileSync(join(home, "secrets/promote.token"), "utf8").trim();
  } catch {
    // The token is created by the first service-starting command.
  }
  const proc = Bun.spawn(
    [bun, join(consumer, "node_modules/@legionworks/facet/src/cli/main.ts"), ...args],
    {
      cwd: consumer,
      env: {
        ...process.env,
        FACET_HOME: home,
        ...(promoteToken ? { FACET_PROMOTE_TOKEN: promoteToken } : {}),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const allowed = options.allowExit ?? [0];
  assert(allowed.includes(exitCode), `${args.join(" ")} exited ${exitCode}: ${stderr}`);
  let envelope: Envelope;
  try {
    envelope = JSON.parse(stdout) as Envelope;
  } catch (error) {
    throw new Error(`${args.join(" ")} emitted invalid JSON\n${stdout}\n${stderr}`, {
      cause: error,
    });
  }
  assert(envelope.schemaVersion === "facet.v1", `${args.join(" ")} returned an invalid envelope`);
  return envelope;
}

function data(envelope: Envelope, command: string): Record<string, unknown> {
  assert(
    envelope.ok === true,
    `${command} returned an error envelope: ${JSON.stringify(envelope)}`,
  );
  assert(envelope.data !== undefined, `${command} returned no data`);
  return envelope.data;
}

async function main(): Promise<void> {
  mkdirSync(consumer, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(join(home, "secrets/promote.token"), `package-install-${crypto.randomUUID()}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "facet-consumer", private: true }),
  );
  writeFileSync(fixture, "# Packed install\n\nThis source proves the installed CLI round-trip.\n");

  try {
    const pack = Bun.spawn([bun, "pm", "pack", "--filename", join(scratch, "facet.tgz")], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [packOut, packErr, packExit] = await Promise.all([
      new Response(pack.stdout).text(),
      new Response(pack.stderr).text(),
      pack.exited,
    ]);
    assert(packExit === 0, `bun pm pack failed: ${packErr}\n${packOut}`);

    const install = Bun.spawn([bun, "install", "--no-save", join(scratch, "facet.tgz")], {
      cwd: consumer,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [installOut, installErr, installExit] = await Promise.all([
      new Response(install.stdout).text(),
      new Response(install.stderr).text(),
      install.exited,
    ]);
    assert(installExit === 0, `bun install failed: ${installErr}\n${installOut}`);

    const version = data(await run(["--version", "--format", "json"]), "--version");
    assert(version.version === packageJson.version, `version mismatch: ${String(version.version)}`);
    data(await run(["doctor"], { allowExit: [0, 1] }), "doctor");
    data(await run(["status", "--start"]), "status --start");

    const created = data(
      await run([
        "create",
        "--project-id",
        "package-install",
        "--slug",
        "packed-install",
        "--title",
        "Packed install",
      ]),
      "create",
    );
    const artifact = created.artifact as Record<string, unknown>;
    const artifactId = artifact.id;
    assert(typeof artifactId === "string", "create did not return an artifact id");

    assert(
      existsSync(join(consumer, "node_modules/@legionworks/facet/scripts/launch-netns.sh")),
      "publish: packed package is missing scripts/launch-netns.sh",
    );
    const published = data(
      await run(["publish", "--artifact-id", artifactId, "--type", "markdown", "--file", fixture]),
      "publish",
    );
    const revision = published.revision as Record<string, unknown>;
    const revisionSha = revision.sha256;
    assert(typeof revisionSha === "string", "publish did not return a revision sha");
    data(
      await run([
        "read-back",
        "--artifact-id",
        artifactId,
        "--revision-sha",
        revisionSha,
        "--tier",
        "0",
      ]),
      "read-back",
    );

    const templateCreated = data(
      await run([
        "create",
        "--project-id",
        "package-install",
        "--slug",
        "packed-template-source",
        "--title",
        "Packed template source",
      ]),
      "create template source",
    );
    const templateArtifact = templateCreated.artifact as Record<string, unknown>;
    const templateArtifactId = templateArtifact.id;
    assert(typeof templateArtifactId === "string", "template create did not return an artifact id");
    const templatePublished = data(
      await run([
        "publish",
        "--artifact-id",
        templateArtifactId,
        "--type",
        "tsx",
        "--file",
        join(consumer, "node_modules/@legionworks/facet/templates/incident-console.tsx"),
      ]),
      "publish template",
    );
    const templateRevision = templatePublished.revision as Record<string, unknown>;
    const templateRevisionId = templateRevision.id;
    assert(typeof templateRevisionId === "string", "template publish did not return a revision id");
    data(
      await run([
        "promote",
        "--artifact-id",
        templateArtifactId,
        "--revision-id",
        templateRevisionId,
        "--name",
        "incident-console",
        "--promoted-by",
        "package-install",
      ]),
      "promote template",
    );
    const instantiated = data(
      await run([
        "instantiate",
        "--name",
        "incident-console",
        "--new-slug",
        "packed-template",
        "--project-id",
        "package-install",
      ]),
      "instantiate",
    );
    assert(
      instantiated.template !== undefined || instantiated.artifact !== undefined,
      "instantiate returned no template result",
    );

    const opened = data(
      await run([
        "open",
        "--artifact-id",
        artifactId,
        "--revision-sha",
        revisionSha,
        "--no-launch",
      ]),
      "open",
    );
    const frameUrl = opened.frameUrl;
    assert(typeof frameUrl === "string", "open did not return frameUrl");
    const origin = new URL(frameUrl).origin;
    const shell = await fetch(`${origin}/gallery`);
    assert(shell.ok && (await shell.text()).includes("<html"), "gallery shell did not serve");
    const asset = await fetch(`${origin}/gallery/frame/frame.css`);
    assert(asset.ok && (await asset.text()).length > 0, "gallery frame asset did not serve");

    chmodTree(join(consumer, "node_modules/@legionworks/facet"));
    const readonlyAsset = await fetch(`${origin}/gallery/frame/frame.css`);
    assert(
      readonlyAsset.ok && (await readonlyAsset.text()).length > 0,
      "read-only gallery fallback did not serve",
    );

    const exportedResult = await run([
      "export",
      artifactId,
      "--revision",
      revisionSha,
      "--format",
      "source",
      "--out",
      exported,
    ]);
    data(exportedResult, "export");
    assert(readFileSync(exported, "utf8").includes("Packed install"), "exported source mismatch");
    console.log(`PASS packed install E2E (${packageJson.version})`);
  } finally {
    await stopService();
    Bun.spawnSync(["chmod", "-R", "u+w", scratch]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function chmodTree(path: string): void {
  const proc = Bun.spawnSync(["chmod", "-R", "a-w", path]);
  assert(proc.exitCode === 0, `failed to make installed package read-only: ${path}`);
}

async function stopService(): Promise<void> {
  try {
    const lock = JSON.parse(readFileSync(join(home, "run/facet.lock"), "utf8")) as { pid?: number };
    if (typeof lock.pid !== "number") return;
    process.kill(lock.pid, "SIGTERM");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Bun.sleep(50);
      try {
        process.kill(lock.pid, 0);
      } catch {
        return;
      }
    }
  } catch {
    // No service was started, or it already exited.
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `FAIL packed install E2E: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
