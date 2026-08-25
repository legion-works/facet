import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * All runtime paths the service writes to. Pure path computation — no
 * filesystem effects. Callers (the database opener, the validation
 * harness) own the actual mkdir/chmod calls so the path layer can be
 * exercised in tests without touching the disk.
 */
export interface FacetRuntimePaths {
  /** Persistent state: the SQLite database (with its WAL/SHM sidecars). */
  readonly database: string;
  /** Per-run evidence: screenshots, console captures, request logs. */
  readonly evidence: string;
  /** Long-lived secret material: the promote-capability token. */
  readonly token: string;
  /** Cross-process lock guarding single-writer sections. */
  readonly lock: string;
  /** Free-form metadata (project name, gallery title, etc.). */
  readonly metadata: string;
}

export interface FacetPathEnvironment {
  readonly facetHome?: string;
  readonly xdgDataHome?: string;
  readonly xdgStateHome?: string;
  readonly xdgConfigHome?: string;
  readonly xdgCacheHome?: string;
}

const FALLBACK_XDG_DATA = `${process.env.HOME ?? ""}/.local/share`;
const FALLBACK_XDG_STATE = `${process.env.HOME ?? ""}/.local/state`;
const FALLBACK_XDG_CONFIG = `${process.env.HOME ?? ""}/.config`;
const FALLBACK_XDG_CACHE = `${process.env.HOME ?? ""}/.cache`;

/**
 * Resolve generated gallery assets to the checkout when it can be written,
 * otherwise use the operator-owned cache so installed packages stay immutable.
 */
export function resolveGalleryRoot(packageRoot: string, env: FacetPathEnvironment = {}): string {
  try {
    accessSync(packageRoot, constants.W_OK);
    return join(packageRoot, "dist", "gallery");
  } catch {
    const facetHome = env.facetHome ?? process.env.FACET_HOME;
    if (facetHome) return join(facetHome, "cache", "gallery");
    const cacheHome = env.xdgCacheHome ?? process.env.XDG_CACHE_HOME ?? FALLBACK_XDG_CACHE;
    return join(cacheHome, "facet", "gallery");
  }
}

/**
 * Compute the five runtime paths. XDG-style: data/state/configurable
 * each have their own override; `facetHome` (or `FACET_HOME`) wins
 * outright when set so operators can run a fully self-contained
 * install without polluting their home directory.
 */
export function computeFacetPaths(env: FacetPathEnvironment = {}): FacetRuntimePaths {
  const facetHome = env.facetHome ?? process.env.FACET_HOME;
  if (facetHome) {
    return {
      database: join(facetHome, "db", "facet.sqlite"),
      evidence: join(facetHome, "evidence"),
      token: join(facetHome, "secrets", "promote.token"),
      lock: join(facetHome, "run", "facet.lock"),
      metadata: join(facetHome, "metadata.json"),
    };
  }
  const dataHome = env.xdgDataHome ?? process.env.XDG_DATA_HOME ?? FALLBACK_XDG_DATA;
  const stateHome = env.xdgStateHome ?? process.env.XDG_STATE_HOME ?? FALLBACK_XDG_STATE;
  const configHome = env.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? FALLBACK_XDG_CONFIG;
  return {
    database: join(dataHome, "facet", "db", "facet.sqlite"),
    evidence: join(stateHome, "facet", "evidence"),
    token: join(dataHome, "facet", "secrets", "promote.token"),
    lock: join(stateHome, "facet", "run", "facet.lock"),
    metadata: join(configHome, "facet", "metadata.json"),
  };
}

/**
 * Legacy evidence root for XDG-default installs predating explicit
 * evidence-root threading. Before the parent CLI passed its evidence root
 * to the service child, the child derived its paths from
 * `FACET_HOME = <dataHome>/facet` (see `spawnChild`) and wrote evidence to
 * `<dataHome>/facet/evidence`, while the parent read
 * `<stateHome>/facet/evidence`. Returns that child-derived root in XDG mode
 * so readers can tolerate the divergence; returns null when `FACET_HOME` is
 * set (that mode never diverged — parent and child always agreed).
 */
export function legacyXdgEvidenceRoot(env: FacetPathEnvironment = {}): string | null {
  const facetHome = env.facetHome ?? process.env.FACET_HOME;
  if (facetHome) return null;
  const dataHome = env.xdgDataHome ?? process.env.XDG_DATA_HOME ?? FALLBACK_XDG_DATA;
  return join(dataHome, "facet", "evidence");
}
