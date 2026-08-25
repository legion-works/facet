import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveGalleryRoot } from "../../src/shared/config/paths";

const REPOSITORY_ROOT = join(import.meta.dir, "../..");
const PACKAGE_JSON_PATH = join(REPOSITORY_ROOT, "package.json");

const LOAD_BEARING_FILES = [
  "src/**",
  "scripts/launch-netns.sh",
  "scripts/build-gallery.ts",
  "templates/**",
  "dist/gallery/**",
  "skills/**",
  "README.md",
  "LICENSE-*",
  "docs/reference/**",
] as const;

function packageManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as Record<string, unknown>;
}

describe("npm package manifest", () => {
  test("declares the publishable identity and every load-bearing runtime path", () => {
    const manifest = packageManifest();
    expect(manifest.name).toBe("@legionworks/facet");
    expect(manifest.private).toBe(false);
    expect(manifest.publishConfig).toEqual({ access: "public" });
    expect(manifest.engines).toEqual({ bun: ">=1.4.0" });
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/legion-works/facet.git",
    });
    expect(manifest.homepage).toBe("https://github.com/legion-works/facet#readme");
    expect(manifest.bugs).toEqual({ url: "https://github.com/legion-works/facet/issues" });
    expect(manifest.keywords).toEqual([
      "artifacts",
      "bun",
      "facet",
      "gallery",
      "rendering",
      "validation",
    ]);
    expect(manifest.license).toBe("MIT OR Apache-2.0");
    expect(manifest.bin).toEqual({
      facet: "./src/cli/main.ts",
      "facet-mcp": "./src/harness-adapters/mcp/main.ts",
    });
    expect((manifest.scripts as Record<string, unknown>).prepack).toBe(
      "bun scripts/build-gallery.ts --if-stale",
    );
    expect(manifest.files).toEqual(LOAD_BEARING_FILES);
  });
});

describe("read-only installed gallery", () => {
  test("uses the package dist root when the package directory is writable", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "facet-gallery-package-"));
    try {
      expect(resolveGalleryRoot(packageRoot, { facetHome: "/facet-home" })).toBe(
        join(packageRoot, "dist", "gallery"),
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  test("uses the FACET_HOME cache when the package directory is read-only", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "facet-gallery-package-"));
    const originalMode = statSync(packageRoot).mode & 0o777;
    try {
      chmodSync(packageRoot, 0o555);
      expect(resolveGalleryRoot(packageRoot, { facetHome: "/facet-home" })).toBe(
        "/facet-home/cache/gallery",
      );
    } finally {
      chmodSync(packageRoot, originalMode);
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  test("builds gallery assets in the FACET_HOME cache when the package is read-only", async () => {
    const originalMode = statSync(REPOSITORY_ROOT).mode & 0o777;
    const cacheRoot = mkdtempSync(join(tmpdir(), "facet-gallery-cache-"));
    const packageGallery = join(REPOSITORY_ROOT, "dist", "gallery");
    rmSync(packageGallery, { recursive: true, force: true });

    try {
      chmodSync(REPOSITORY_ROOT, 0o555);
      const process = Bun.spawn(["bun", "scripts/build-gallery.ts"], {
        cwd: REPOSITORY_ROOT,
        env: { ...Bun.env, FACET_HOME: cacheRoot },
        stdout: "ignore",
        stderr: "pipe",
      });
      const exitCode = await process.exited;
      const details = await new Response(process.stderr).text();
      expect(exitCode, details).toBe(0);
      expect(await Bun.file(join(cacheRoot, "cache", "gallery", "index.html")).exists()).toBe(true);
      expect(
        await Bun.file(join(cacheRoot, "cache", "gallery", "frame", "frame.css")).exists(),
      ).toBe(true);
      expect(await Bun.file(join(packageGallery, "index.html")).exists()).toBe(false);
    } finally {
      chmodSync(REPOSITORY_ROOT, originalMode);
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
