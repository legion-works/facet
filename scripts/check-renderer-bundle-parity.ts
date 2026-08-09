#!/usr/bin/env bun

import { basename, join } from "node:path";

import { frameBundlePlugins } from "../src/shared/build/frame-bundle-plugins";

const REPO_ROOT = import.meta.dir.replace(/\/scripts$/, "");
const ARTIFACT_TYPES = ["markdown", "mermaid", "svg", "chart"] as const;
type ArtifactType = (typeof ARTIFACT_TYPES)[number];

const EXPECTED_RENDERERS: Readonly<Record<ArtifactType, readonly string[]>> = {
  markdown: ["markdown.ts", "mermaid.ts", "svg.ts"],
  mermaid: ["mermaid.ts", "svg.ts"],
  svg: ["svg.ts"],
  chart: ["chart.ts", "svg.ts"],
};
const EXPECTED_INITIAL_RENDERERS: Readonly<Record<ArtifactType, readonly string[]>> = {
  markdown: ["markdown.ts"],
  mermaid: ["mermaid.ts", "svg.ts"],
  svg: ["svg.ts"],
  chart: ["chart.ts", "svg.ts"],
};

interface BuildMetafileOutput {
  readonly entryPoint?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly imports: readonly { readonly path: string; readonly kind: string }[];
}

function parseArtifactType(value: string): ArtifactType {
  if ((ARTIFACT_TYPES as readonly string[]).includes(value)) return value as ArtifactType;
  throw new Error(`unknown renderer bundle type '${value}'`);
}

function verifierEntryType(artifactType: ArtifactType): ArtifactType {
  const mutation = process.env.FACET_TEST_RENDERER_PARITY_MUTATION;
  if (mutation === undefined) return artifactType;
  const [target, replacement, extra] = mutation.split("=");
  if (extra !== undefined || target === undefined || replacement === undefined) {
    throw new Error("FACET_TEST_RENDERER_PARITY_MUTATION must be '<type>=<type>'");
  }
  return artifactType === parseArtifactType(target) ? parseArtifactType(replacement) : artifactType;
}

function rendererNames(inputs: readonly string[]): string[] {
  return inputs
    .filter((path) => path.includes("/gallery-web/frame/renderers/"))
    .map((path) => basename(path))
    .filter((name) => name !== "registry.ts" && name !== "dompurify-shim.ts")
    .toSorted();
}

async function rendererSources(
  entry: string,
  splitting: boolean,
  followDynamicImports: boolean,
): Promise<{ readonly all: string[]; readonly initial: string[] }> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    metafile: true,
    splitting,
    plugins: frameBundlePlugins(),
    throw: false,
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const metafile = result.metafile;
  const all = rendererNames(Object.keys(metafile?.inputs ?? {}));
  if (!splitting || metafile === undefined) return { all, initial: all };

  const outputs = metafile.outputs as Readonly<Record<string, BuildMetafileOutput>>;
  const entryOutput = Object.entries(outputs).find(([, output]) => output.entryPoint !== undefined);
  if (entryOutput === undefined) throw new Error(`bundle has no entry output for ${entry}`);
  const pending = [entryOutput[0]];
  const visited = new Set<string>();
  const initialInputs = new Set<string>();
  while (pending.length > 0) {
    const outputPath = pending.pop();
    if (outputPath === undefined || visited.has(outputPath)) continue;
    visited.add(outputPath);
    const output = outputs[outputPath];
    if (output === undefined)
      throw new Error(`bundle output '${outputPath}' is missing from metafile`);
    for (const input of Object.keys(output.inputs)) initialInputs.add(input);
    for (const imported of output.imports) {
      if (imported.kind === "import-statement" || followDynamicImports) pending.push(imported.path);
    }
  }
  return { all, initial: rendererNames([...initialInputs]) };
}

function assertEqualSets(
  artifactType: ArtifactType,
  expected: readonly string[],
  gallery: readonly string[],
  verifier: readonly string[],
): void {
  const expectedJson = JSON.stringify(expected);
  const galleryJson = JSON.stringify(gallery);
  const verifierJson = JSON.stringify(verifier);
  if (
    galleryJson !== expectedJson ||
    verifierJson !== expectedJson ||
    galleryJson !== verifierJson
  ) {
    throw new Error(
      `renderer bundle parity mismatch for ${artifactType}: expected=${expectedJson} gallery=${galleryJson} verifier=${verifierJson}`,
    );
  }
}

const verified: Partial<Record<ArtifactType, readonly string[]>> = {};
for (const artifactType of ARTIFACT_TYPES) {
  const gallery = await rendererSources(
    join(REPO_ROOT, "src", "gallery-web", "frame", "entries", `${artifactType}.ts`),
    true,
    process.env.FACET_TEST_RENDERER_STATIC_MUTATION === artifactType,
  );
  const verifier = await rendererSources(
    join(
      REPO_ROOT,
      "src",
      "validation",
      "tier1",
      "entries",
      `${verifierEntryType(artifactType)}.ts`,
    ),
    false,
    false,
  );
  const expected = [...EXPECTED_RENDERERS[artifactType]].toSorted();
  assertEqualSets(artifactType, expected, gallery.all, verifier.all);
  const expectedInitial = [...EXPECTED_INITIAL_RENDERERS[artifactType]].toSorted();
  if (JSON.stringify(gallery.initial) !== JSON.stringify(expectedInitial)) {
    throw new Error(
      `initial renderer load mismatch for ${artifactType}: expected=${JSON.stringify(expectedInitial)} actual=${JSON.stringify(gallery.initial)}`,
    );
  }
  verified[artifactType] = gallery.all;
}

process.stdout.write(`${JSON.stringify(verified)}\n`);
