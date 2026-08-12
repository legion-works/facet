/**
 * Shared fixture paths for the compiler comparison harness. Defined in a
 * separate module so the harness can be spawned as a fresh subprocess and
 * still find the same source files.
 */
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "..", "tests", "fixtures", "tsx");

export const STATIC_SOURCE_PATH = join(FIXTURES_DIR, "static-source.tsx");
export const INTERACTIVE_SOURCE_PATH = join(FIXTURES_DIR, "interactive-source.tsx");
export const EMPTY_SOURCE_PATH = join(FIXTURES_DIR, "empty-source.tsx");
