/**
 * CLI presenter — pretty output for interactive terminals.
 *
 * Reference implementation for the output design; wiring is one
 * branch at the `printEnvelope` call site in main.ts:
 *
 *   if (shouldPresentPretty({ isTTY: process.stdout.isTTY === true,
 *                             jsonFlag: flags.json === true,
 *                             env: process.env })) {
 *     for (const line of presentEnvelope(envelope, caps)) writer.write(line + "\n");
 *   } else {
 *     printEnvelope(writer, envelope);   // unchanged contract path
 *   }
 *
 * Contract safety:
 *   - A pipe NEVER sees pretty output — adapters keep byte-identical
 *     envelopes. `--json` forces the envelope even on a TTY.
 *   - Exit codes are untouched (0 / 64 / 70).
 *   - Wire strings stay verbatim except the verdict word, which drops
 *     its `partial:` detail into a labeled row.
 *
 * Color policy: ANSI-16 only, Legion Works roles — green 32, red 31,
 * yellow 33, cyan 36, blue 34, bright-black 90, inverse 7 (tampered
 * only). NO_COLOR or a non-TTY zeroes every escape; the glyph column
 * carries the verdict alone.
 */

import type { FacetEnvelope } from "../shared/contracts/envelope";
import type { RenderStatus, Verdict } from "../shared/contracts/validation";

export interface PresenterCaps {
  readonly color: boolean;
}

export interface PresentRouting {
  readonly isTTY: boolean;
  readonly jsonFlag: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** TTY → pretty; pipe or --json → envelope. */
export function shouldPresentPretty(routing: PresentRouting): boolean {
  return routing.isTTY && !routing.jsonFlag;
}

export function presenterCaps(routing: PresentRouting): PresenterCaps {
  return { color: routing.isTTY && routing.env["NO_COLOR"] === undefined };
}

/** One glyph per RenderStatus — identical to verdict.css. */
export const VERDICT_GLYPH: Record<RenderStatus, string> = {
  ok: "✓",
  error: "✗",
  "partial:layout_unverified": "◐",
  "partial:opaque_content": "◐",
  "partial:external_resources": "◐",
  "partial:unstable": "◐",
  tampered: "⊘",
  timeout: "◌",
  shim_only: "◇",
  probe_only: "◈",
  "insecure:unvalidated": "⊘",
};

const SGR = {
  green: "32",
  red: "31",
  yellow: "33",
  cyan: "36",
  blue: "34",
  dim: "90",
  bold: "1",
  redInverse: "31;7",
} as const;

type Tone = keyof typeof SGR;

const STATUS_TONE: Record<RenderStatus, Tone> = {
  ok: "green",
  error: "red",
  "partial:layout_unverified": "yellow",
  "partial:opaque_content": "yellow",
  "partial:external_resources": "yellow",
  "partial:unstable": "yellow",
  tampered: "redInverse",
  timeout: "dim",
  shim_only: "dim",
  probe_only: "dim",
  "insecure:unvalidated": "redInverse",
};

function makePaint(caps: PresenterCaps) {
  return (tone: Tone, text: string): string =>
    caps.color ? `\u001b[${SGR[tone]}m${text}\u001b[0m` : text;
}

const sha8 = (sha: string): string => sha.slice(0, 8);

/** `  label<pad to 10>value` detail row. */
function row(label: string, value: string): string {
  return `  ${label.padEnd(10, " ")}${value}`;
}

function verdictLines(verdict: Verdict, caps: PresenterCaps): string[] {
  const paint = makePaint(caps);
  const tone = STATUS_TONE[verdict.status];
  const [word, detail] = verdict.status.split(":") as [string, string | undefined];
  const head = [
    paint(tone, `${VERDICT_GLYPH[verdict.status]} ${word}`),
    ...(detail === undefined ? [] : [paint("dim", detail)]),
    paint("dim", `tier ${verdict.tier}`),
    `${verdict.artifactId} ${paint("dim", "@")} ${paint("cyan", sha8(verdict.revisionSha))}`,
  ].join(paint("dim", " · "));
  const o = verdict.observed;
  const lines = [
    ...(verdict.insecure === undefined
      ? []
      : [`INSECURE L${verdict.insecure.level} — ${verdict.insecure.reason}`]),
    head,
    row(
      "observed",
      `svg ${o.rendererRootSvgCount} · graphs ${o.graphCount} · nodes ${o.mermaidNodeCount} · errors ${o.errorCount}`,
    ),
  ];
  const first = o.discriminativeErrors?.[0];
  if (first !== undefined)
    lines.push(row("detail", paint("red", `${first.code} — ${first.message}`)));
  const screenshot = (verdict as { screenshotPath?: string | null }).screenshotPath;
  if (typeof screenshot === "string") lines.push(row("evidence", paint("blue", screenshot)));
  return lines;
}

/**
 * Envelope → pretty lines. Knows readBack / publish / status closely;
 * every other command falls back to a one-line acknowledgement so a
 * new verb never renders as nothing.
 */
export function presentEnvelope(envelope: FacetEnvelope<unknown>, caps: PresenterCaps): string[] {
  const paint = makePaint(caps);
  if (!envelope.ok) {
    const err = envelope.error;
    return [
      `${paint("red", `✗ ${err.code}`)}${paint("dim", ` · retryable ${err.retryable ? "yes" : "no"}`)}`,
      row("", err.message),
    ];
  }
  const data = envelope.data as Record<string, unknown>;
  const command = typeof data?.["command"] === "string" ? (data["command"] as string) : null;

  if (command === "readBack" && typeof data["verdict"] === "object" && data["verdict"] !== null) {
    return verdictLines(data["verdict"] as Verdict, caps);
  }

  if (command === "publish") {
    const revision = data["revision"] as { sha256?: string } | undefined;
    const lines = [
      `${paint("cyan", "● published")}${
        revision?.sha256 === undefined
          ? ""
          : `${paint("dim", " · rev ")}${paint("cyan", sha8(revision.sha256))}`
      }`,
    ];
    if (revision?.sha256 !== undefined) {
      lines.push(row("read-back", `facet read-back --revision-sha ${revision.sha256}`));
    }
    const tier1 = data["tier1Verdict"];
    if (typeof tier1 === "object" && tier1 !== null) {
      lines.push(...verdictLines(tier1 as Verdict, caps));
    }
    return lines;
  }

  if (command === "status") {
    const state = data["state"];
    if (state === "dormant") {
      return [
        `${paint("dim", "◌ dormant")}${paint("dim", " · zero processes · zero ports — healthy")}`,
      ];
    }
    if (state === "active") {
      const jobs = data["activeJobs"];
      return [
        `${paint("green", "● active")}${paint(
          "dim",
          typeof jobs === "number" ? ` · jobs ${jobs}` : "",
        )}`,
      ];
    }
  }

  if (command === "doctor") {
    const probes = Array.isArray(data["probes"]) ? data["probes"] : [];
    const lines: string[] = [];
    for (const item of probes) {
      if (typeof item !== "object" || item === null) continue;
      const probe = item as {
        name?: unknown;
        status?: unknown;
        summary?: unknown;
        fixCommand?: unknown;
      };
      const passed = probe.status === "pass";
      lines.push(
        `${paint(passed ? "green" : "red", `${passed ? "✓" : "✗"} ${String(probe.name)}`)} · ${String(probe.summary)}`,
      );
      if (!passed && typeof probe.fixCommand === "string") lines.push(row("fix", probe.fixCommand));
    }
    return lines;
  }

  return [`${paint("green", "✓ ok")}${command === null ? "" : paint("dim", ` · ${command}`)}`];
}
