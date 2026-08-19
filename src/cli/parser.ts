/**
 * CLI argv parser.
 *
 * Single source of truth for the verb set + per-verb flag surface.
 * The parser is intentionally a tiny recursive-descent walker — the
 * CLI surface is small (10 verbs, ~25 flags) and a hand-rolled parser
 * is easier to audit than a library. The parser NEVER throws for
 * bad input; it returns a discriminated result so the caller can
 * produce a typed usage-error envelope.
 *
 * Help text generation lives here too (`renderHelp`); the same code
 * path is used by the test that asserts the help output contains the
 * full verb list, so the help surface can never silently shrink.
 */

import {
  IMPLEMENTED_COMMANDS,
  RESERVED_COMMANDS,
  type CommandName,
} from "../shared/contracts/commands/names";
import { RENDERERS } from "../shared/contracts/renderers";
import { TSX_EXECUTION_MODES } from "../shared/tsx/execution";

/**
 * Parsed CLI invocation. `verb === null` for the meta-commands
 * (`--help`, `--version`); `verb !== null` for every v1 verb.
 */
export type ParsedCommand =
  | { readonly kind: "help"; readonly format: "text" | "json"; readonly verb?: CommandName }
  | { readonly kind: "version"; readonly format: "text" | "json" }
  | {
      readonly kind: "verb";
      readonly verb: CommandName;
      readonly args: Readonly<Record<string, string | boolean>>;
      readonly format: "text" | "json";
      readonly jsonFlag: boolean;
    }
  | {
      readonly kind: "usage";
      readonly message: string;
      readonly details?: Readonly<Record<string, string>>;
    };

/**
 * Per-verb flag surface. Each entry is the list of accepted flags
 * (`--flag` or `--flag <value>`) for that verb. The parser rejects
 * unknown flags with a typed usage error.
 */
interface FlagDefinition {
  readonly flag: string;
  readonly takesValue: boolean;
  readonly values?: readonly string[];
  readonly required?: boolean;
}

const VERB_FLAGS: Readonly<Record<CommandName, readonly FlagDefinition[]>> = {
  create: [
    { flag: "--project-id", takesValue: true, required: true },
    { flag: "--slug", takesValue: true, required: true },
    { flag: "--title", takesValue: true, required: true },
  ],
  publish: [
    { flag: "--artifact-id", takesValue: true, required: true },
    { flag: "--type", takesValue: true, required: true },
    { flag: "--renderer", takesValue: true, values: [...RENDERERS] },
    { flag: "--execution", takesValue: true, values: [...TSX_EXECUTION_MODES] },
    { flag: "--file", takesValue: true, required: true },
    { flag: "--note", takesValue: true },
    { flag: "--parent-revision-id", takesValue: true },
  ],
  list: [
    { flag: "--project-id", takesValue: true, required: true },
    { flag: "--slug-prefix", takesValue: true },
    { flag: "--limit", takesValue: true },
  ],
  readBack: [
    { flag: "--artifact-id", takesValue: true, required: true },
    { flag: "--revision-sha", takesValue: true },
    { flag: "--tier", takesValue: true },
  ],
  status: [
    { flag: "--artifact-id", takesValue: true },
    { flag: "--start", takesValue: false },
  ],
  open: [
    { flag: "--artifact-id", takesValue: true, required: true },
    { flag: "--revision-sha", takesValue: true, required: true },
  ],
  promote: [
    { flag: "--artifact-id", takesValue: true },
    { flag: "--revision-id", takesValue: true, required: true },
    { flag: "--name", takesValue: true, required: true },
    { flag: "--description", takesValue: true },
    { flag: "--promoted-by", takesValue: true, required: true },
  ],
  instantiate: [
    { flag: "--name", takesValue: true, required: true },
    { flag: "--new-slug", takesValue: true, required: true },
    { flag: "--project-id", takesValue: true },
  ],
  pin: [
    { flag: "--revision-id", takesValue: true, required: true },
    { flag: "--pinned", takesValue: true, required: true },
  ],
  export: [
    { flag: "--revision", takesValue: true },
    { flag: "--format", takesValue: true, values: ["source", "render"] },
    { flag: "--out", takesValue: true },
    { flag: "--force", takesValue: false },
    { flag: "--include-bytes", takesValue: false },
  ],
};

/** Map CLI verb names to wire `command` names. Only `read-back` differs. */
const VERB_TO_COMMAND: Readonly<Record<string, CommandName>> = {
  create: "create",
  publish: "publish",
  list: "list",
  "read-back": "readBack",
  status: "status",
  open: "open",
  promote: "promote",
  instantiate: "instantiate",
  pin: "pin",
  export: "export",
};

const COMMAND_TO_VERB: Readonly<Record<CommandName, string>> = {
  create: "create",
  publish: "publish",
  list: "list",
  readBack: "read-back",
  status: "status",
  open: "open",
  promote: "promote",
  instantiate: "instantiate",
  pin: "pin",
  export: "export",
};

/**
 * Read `--format text|json` from the argv, defaulting to `text`.
 * Only `--help` and `--version` honor the flag — verb calls always
 * print a JSON envelope on stdout. The flag is recognized in any
 * position so adapters can pass it either first or last.
 */
function readFormat(argv: readonly string[]): "text" | "json" | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--format") {
      const value = argv[i + 1];
      if (value === "text" || value === "json") return value;
      return null;
    } else if (arg === "--json") {
      return "json";
    }
  }
  return "text";
}

/** Strip format metadata for non-export verbs; export owns its format flag. */
function withoutFormatFlags(argv: readonly string[], stripVerbFormat: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--json") continue;
    if (stripVerbFormat && arg === "--format") {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function parseArgs(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0) return { kind: "help", format: "text" };
  const firstRaw = argv[0];
  const isMeta =
    firstRaw === "--help" || firstRaw === "-h" || firstRaw === "--version" || firstRaw === "-V";
  const metaFormat = isMeta ? readFormat(argv) : "text";
  if (metaFormat === null) {
    return {
      kind: "usage",
      message: "Flag '--format' must be one of: text, json",
      details: { flag: "--format", allowedValues: "text, json" },
    };
  }
  const format = metaFormat;
  const jsonFlag = argv.includes("--json");
  const firstCommand = typeof firstRaw === "string" ? VERB_TO_COMMAND[firstRaw] : undefined;
  // `--format` is scoped to `--help`/`--version` metadata and to export's
  // source|render argument; every other verb used to have `--format` (and
  // its value) silently dropped by `withoutFormatFlags` BEFORE flag
  // validation ran, so an unsupported or mistyped `--format` on e.g.
  // `publish` ran the verb as if the flag were absent instead of failing.
  if (
    !isMeta &&
    firstCommand !== undefined &&
    firstCommand !== "export" &&
    argv.includes("--format")
  ) {
    return { kind: "usage", message: `Flag '--format' is not supported for '${firstRaw}'` };
  }
  const stripped = withoutFormatFlags(
    argv,
    isMeta || (firstCommand !== undefined && firstCommand !== "export"),
  );

  const first = stripped[0];
  if (first === "--help" || first === "-h") return { kind: "help", format };
  if (first === "--version" || first === "-V") return { kind: "version", format };

  const verb = first;
  if (verb === undefined) return { kind: "help", format };
  const command = VERB_TO_COMMAND[verb];
  if (command === undefined) {
    return { kind: "usage", message: `Unknown verb: '${verb}'` };
  }
  if (stripped.slice(1).includes("--help") || stripped.slice(1).includes("-h")) {
    return { kind: "help", format, verb: command };
  }

  const flags = VERB_FLAGS[command];
  const args: Record<string, string | boolean> = {};
  for (let i = 1; i < stripped.length; i += 1) {
    const flag = stripped[i];
    if (flag === undefined) continue;
    if (!flag.startsWith("--")) {
      if (command !== "export" || args["artifact-id"] !== undefined) {
        return { kind: "usage", message: `Unexpected positional argument: '${flag}'` };
      }
      args["artifact-id"] = flag;
      continue;
    }
    const def = flags.find((f) => f.flag === flag);
    if (def === undefined) {
      return { kind: "usage", message: `Unknown flag for '${verb}': '${flag}'` };
    }
    if (def.takesValue) {
      const value = stripped[i + 1];
      if (value === undefined) {
        return { kind: "usage", message: `Flag '${flag}' requires a value` };
      }
      if (def.values !== undefined && !def.values.includes(value)) {
        return {
          kind: "usage",
          message: `Flag '${flag}' must be one of: ${def.values.join(", ")} (got '${value}')`,
          details: { flag, allowedValues: def.values.join(", ") },
        };
      }
      args[flag.slice(2)] = value;
      i += 1;
    } else {
      args[flag.slice(2)] = true;
    }
  }
  const missing = flags
    .filter((flag) => flag.required === true && args[flag.flag.slice(2)] === undefined)
    .map((flag) => flag.flag);
  if (command === "export" && args["artifact-id"] === undefined) {
    missing.push("<artifactId>");
  }
  if (missing.length > 0) {
    return {
      kind: "usage",
      message: `Missing required input(s) for ${verb}: ${missing.join(", ")}`,
      details: { missing: missing.join(", ") },
    };
  }
  return { kind: "verb", verb: command, args, format, jsonFlag };
}

/**
 * Render the --help text. Single source of truth so the test that
 * asserts the verb list and the "stdout is JSON" line can never
 * silently fail when a new verb is added.
 */
export function renderHelp(verb?: CommandName): string {
  if (verb !== undefined) {
    const commandVerb = COMMAND_TO_VERB[verb];
    const positional = verb === "export" ? " <artifactId>" : "";
    const flags = VERB_FLAGS[verb]
      .map((flag) => {
        const value = flag.takesValue ? " <value>" : "";
        return `  ${flag.flag}${value}${flag.required === true ? "  required" : ""}`;
      })
      .join("\n");
    return [
      `Usage: facet ${commandVerb}${positional} [--flag value]...`,
      "",
      positional.length > 0 ? "Positionals:" : "",
      ...(positional.length > 0 ? ["  <artifactId>  artifact identifier to export"] : []),
      ...(positional.length > 0 ? [""] : []),
      "Flags:",
      flags,
      "",
      "stdout is always a versioned JSON envelope for verb calls.",
    ].join("\n");
  }
  const verbs = [...IMPLEMENTED_COMMANDS, ...RESERVED_COMMANDS]
    .map((c) => COMMAND_TO_VERB[c])
    .join(", ");
  const lines: string[] = [
    "facet — Facet v1 command line interface",
    "",
    "Usage:",
    "  facet [--help | --version] [--format text|json]",
    "  facet <verb> [--flag value]...",
    "",
    `Verbs: ${verbs}`,
    "",
    "Source input:",
    "  facet publish --artifact-id <id> --type <t> [--renderer <svg|canvas>] --file <path>   read bytes from a file",
    "  facet publish --artifact-id <id> --type <t> [--renderer <svg|canvas>] --file -        read bytes from stdin",
    "  cat src.md | facet publish --artifact-id <id> --type <t> [--renderer <svg|canvas>]    read bytes from stdin (piped)",
    "",
    "verb stdout is always a versioned JSON envelope; --format applies to meta commands and export only.",
    "diagnostics are stderr.",
    "",
    "Exit codes:",
  ];
  // Defined inline to avoid a circular import (output.ts does not
  // import from parser.ts; this is the only direction). The numbers
  // must stay in sync with src/cli/output.ts.
  const codes: readonly { code: number; meaning: string }[] = [
    { code: 0, meaning: "ok (any well-formed envelope on stdout, incl. typed error)" },
    { code: 64, meaning: "usage error (pre-parse: unknown verb, bad flag)" },
    { code: 70, meaning: "internal (unhandled non-FacetError throw)" },
  ];
  for (const c of codes) lines.push(`  ${c.code}  ${c.meaning}`);
  lines.push("");
  lines.push("Environment:");
  lines.push("  FACET=off   kill switch — exit 0, no service spawned");
  lines.push("  FACET_HOME  override the runtime home (db / lock / tokens live here)");
  return lines.join("\n");
}
