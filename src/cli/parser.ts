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

/**
 * Parsed CLI invocation. `verb === null` for the meta-commands
 * (`--help`, `--version`); `verb !== null` for every v1 verb.
 */
export type ParsedCommand =
  | { readonly kind: "help"; readonly format: "text" | "json" }
  | { readonly kind: "version"; readonly format: "text" | "json" }
  | {
      readonly kind: "verb";
      readonly verb: CommandName;
      readonly args: Readonly<Record<string, string | boolean>>;
      readonly format: "text" | "json";
    }
  | { readonly kind: "usage"; readonly message: string };

/**
 * Per-verb flag surface. Each entry is the list of accepted flags
 * (`--flag` or `--flag <value>`) for that verb. The parser rejects
 * unknown flags with a typed usage error.
 */
const VERB_FLAGS: Readonly<Record<CommandName, readonly { flag: string; takesValue: boolean }[]>> =
  {
    create: [
      { flag: "--project-id", takesValue: true },
      { flag: "--slug", takesValue: true },
      { flag: "--title", takesValue: true },
    ],
    publish: [
      { flag: "--artifact-id", takesValue: true },
      { flag: "--type", takesValue: true },
      { flag: "--file", takesValue: true },
      { flag: "--note", takesValue: true },
      { flag: "--parent-revision-id", takesValue: true },
    ],
    list: [
      { flag: "--project-id", takesValue: true },
      { flag: "--slug-prefix", takesValue: true },
      { flag: "--limit", takesValue: true },
    ],
    readBack: [
      { flag: "--artifact-id", takesValue: true },
      { flag: "--revision-sha", takesValue: true },
      { flag: "--tier", takesValue: true },
    ],
    status: [{ flag: "--artifact-id", takesValue: true }],
    open: [
      { flag: "--artifact-id", takesValue: true },
      { flag: "--revision-sha", takesValue: true },
    ],
    promote: [
      { flag: "--artifact-id", takesValue: true },
      { flag: "--revision-id", takesValue: true },
      { flag: "--name", takesValue: true },
      { flag: "--description", takesValue: true },
      { flag: "--promoted-by", takesValue: true },
    ],
    instantiate: [
      { flag: "--name", takesValue: true },
      { flag: "--new-slug", takesValue: true },
      { flag: "--promoted-by", takesValue: true },
      { flag: "--project-id", takesValue: true },
    ],
    pin: [
      { flag: "--revision-id", takesValue: true },
      { flag: "--pinned", takesValue: true },
    ],
    export: [{ flag: "--format", takesValue: true }],
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
function readFormat(argv: readonly string[]): "text" | "json" {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--format") {
      const value = argv[i + 1];
      if (value === "text" || value === "json") return value;
    } else if (arg === "--json") {
      return "json";
    }
  }
  return "text";
}

/** Strip `--format text|json` and `--json` from argv so the verb parser doesn't see them. */
function withoutFormatFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--format") {
      i += 1;
      continue;
    }
    if (arg === "--json") continue;
    out.push(arg);
  }
  return out;
}

export function parseArgs(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0) return { kind: "help", format: "text" };
  const format = readFormat(argv);
  const stripped = withoutFormatFlags(argv);

  const first = stripped[0];
  if (first === "--help" || first === "-h") return { kind: "help", format };
  if (first === "--version" || first === "-V") return { kind: "version", format };

  const verb = first;
  if (verb === undefined) return { kind: "help", format };
  const command = VERB_TO_COMMAND[verb];
  if (command === undefined) {
    return { kind: "usage", message: `Unknown verb: '${verb}'` };
  }

  const flags = VERB_FLAGS[command];
  const args: Record<string, string | boolean> = {};
  for (let i = 1; i < stripped.length; i += 1) {
    const flag = stripped[i];
    if (flag === undefined) continue;
    if (!flag.startsWith("--")) {
      return { kind: "usage", message: `Unexpected positional argument: '${flag}'` };
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
      args[flag.slice(2)] = value;
      i += 1;
    } else {
      args[flag.slice(2)] = true;
    }
  }
  return { kind: "verb", verb: command, args, format };
}

/**
 * Render the --help text. Single source of truth so the test that
 * asserts the verb list and the "stdout is JSON" line can never
 * silently fail when a new verb is added.
 */
export function renderHelp(): string {
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
    "  facet publish --artifact-id <id> --type <t> --file <path>   read bytes from a file",
    "  facet publish --artifact-id <id> --type <t> --file -        read bytes from stdin",
    "  cat src.md | facet publish --artifact-id <id> --type <t>    read bytes from stdin (piped)",
    "",
    "stdout is JSON; diagnostics are stderr.",
    "",
    "Exit codes:",
  ];
  // Defined inline to avoid a circular import (output.ts does not
  // import from parser.ts; this is the only direction). The numbers
  // are the canonical EX_USAGE / EX_DATAERR / EX_SOFTWARE / EX_TEMPFAIL
  // values and must stay in sync with src/cli/output.ts.
  const codes: readonly { code: number; meaning: string }[] = [
    { code: 0, meaning: "ok" },
    { code: 64, meaning: "usage error (unknown verb, bad flag)" },
    { code: 65, meaning: "data error (envelope shape invalid)" },
    { code: 70, meaning: "internal (spawn / contract-version mismatch)" },
    { code: 75, meaning: "retryable (transient lock / connection)" },
  ];
  for (const c of codes) lines.push(`  ${c.code}  ${c.meaning}`);
  lines.push("");
  lines.push("Environment:");
  lines.push("  FACET=off   kill switch — exit 0, no service spawned");
  lines.push("  FACET_HOME  override the runtime home (db / lock / tokens live here)");
  return lines.join("\n");
}
