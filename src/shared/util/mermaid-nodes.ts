/**
 * Canonical lexical prediction for Mermaid flowchart `g.node` elements.
 *
 * Tier 1 observes renderer-owned `.node` groups. This module teaches the
 * diagram grammars whose output can be predicted reliably; callers receive
 * `null` rather than a misleading zero for every other diagram type.
 */

const FLOWCHART_HEADER_RE = /^(?:flowchart|graph)\b/i;
const SEQUENCE_HEADER_RE = /^sequenceDiagram\b/i;
const STATE_HEADER_RE = /^stateDiagram(?:-v2)?\b/i;
const IGNORED_LINE_RE = /^(?:classDef|class|click|direction|end|linkStyle|style|subgraph)\b/i;
const FENCE_LINE_RE = /^(?:`{3,}|~{3,})/;

type MermaidNodeGrammar = "flowchart" | "sequence" | "state" | "unavailable";

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_-]/.test(char);
}

function shapeEnd(line: string, start: number): number | null {
  const opening = line.slice(start, start + 2);
  const close =
    opening === "[["
      ? "]]"
      : opening === "[("
        ? ")]"
        : opening === "[/"
          ? "\\]"
          : opening === "[\\"
            ? "/]"
            : opening === "(("
              ? "))"
              : opening === "(["
                ? "])"
                : opening === "{{"
                  ? "}}"
                  : line[start] === "["
                    ? "]"
                    : line[start] === "("
                      ? ")"
                      : line[start] === "{"
                        ? "}"
                        : line[start] === ">"
                          ? "]"
                          : null;
  if (close === null) return null;
  const end = line.indexOf(close, start + (opening === "{{" ? 2 : 1));
  return end === -1 ? line.length : end + close.length;
}

function grammarFor(text: string): MermaidNodeGrammar {
  let inDirective = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (FENCE_LINE_RE.test(line)) continue;
    if (inDirective) {
      if (line.includes("}%%")) inDirective = false;
      continue;
    }
    if (line.startsWith("%%{")) {
      if (!line.includes("}%%")) inDirective = true;
      continue;
    }
    if (line.startsWith("%%")) continue;
    if (FLOWCHART_HEADER_RE.test(line)) return "flowchart";
    if (SEQUENCE_HEADER_RE.test(line)) return "sequence";
    if (STATE_HEADER_RE.test(line)) return "state";
    return "unavailable";
  }
  return "unavailable";
}

function countFlowchartNodeIds(text: string): number {
  const ids = new Set<string>();
  let inDirective = false;

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (FENCE_LINE_RE.test(line)) continue;
    if (inDirective) {
      if (line.includes("}%%")) inDirective = false;
      continue;
    }
    if (line.startsWith("%%{")) {
      if (!line.includes("}%%")) inDirective = true;
      continue;
    }
    const commentStart = line.indexOf("%%");
    if (commentStart !== -1) line = line.slice(0, commentStart).trim();
    if (!line || FLOWCHART_HEADER_RE.test(line) || IGNORED_LINE_RE.test(line)) continue;

    // Edge labels are text, never endpoint ids. Strip them before scanning
    // so `A -->|tier 0| B` cannot add `tier` to the prediction.
    line = line.replace(/\|[^|]*\|/g, "");
    let index = 0;
    let expectingNode = true;
    while (index < line.length) {
      const char = line[index]!;
      if (isIdentifierStart(char)) {
        let end = index + 1;
        while (end < line.length && isIdentifierPart(line[end]!)) end += 1;
        const id = line.slice(index, end);
        const endOfShape = shapeEnd(line, end);
        if (expectingNode || endOfShape !== null) ids.add(id);
        expectingNode = false;
        index = endOfShape ?? end;
        continue;
      }
      if (char === "&") {
        expectingNode = true;
        index += 1;
        continue;
      }
      if (char === "-" || char === "=" || char === ".") {
        let end = index + 1;
        while (end < line.length && /[-=.<>]/.test(line[end]!)) end += 1;
        if (end - index >= 2) expectingNode = true;
        index = end;
        continue;
      }
      index += 1;
    }
  }
  return ids.size;
}

function stateOperand(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "[*]") return trimmed;
  const match = trimmed.match(/^[A-Za-z_][A-Za-z0-9_-]*/);
  return match?.[0] ?? null;
}

/**
 * State diagrams render named states once each and render `[*]` as the
 * entry-and-exit pseudo-state pair. Mermaid's parser only reports the
 * diagram type, so this is the smallest grammar needed to match the
 * renderer-owned `g.node` census.
 */
function countStateNodeGroups(text: string): number {
  const states = new Set<string>();
  let pseudoStateOccurrences = 0;
  let inDirective = false;

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (inDirective) {
      if (line.includes("}%%")) inDirective = false;
      continue;
    }
    if (line.startsWith("%%{")) {
      if (!line.includes("}%%")) inDirective = true;
      continue;
    }
    const commentStart = line.indexOf("%%");
    if (commentStart !== -1) line = line.slice(0, commentStart).trim();
    if (!line || STATE_HEADER_RE.test(line) || /^note\b/i.test(line)) continue;

    const arrow = line.indexOf("-->");
    if (arrow === -1) continue;
    const left = stateOperand(line.slice(0, arrow));
    const right = stateOperand(line.slice(arrow + 3).split(":", 1)[0] ?? "");
    for (const operand of [left, right]) {
      if (operand === null) continue;
      if (operand === "[*]") pseudoStateOccurrences += 1;
      else states.add(operand);
    }
  }
  return states.size + pseudoStateOccurrences * 2;
}

/**
 * Return the lexical expectation for Tier 1's Mermaid `g.node` census.
 * `null` means the diagram type has no maintained grammar and must skip the
 * node comparison; it is deliberately distinct from the exact zero for
 * sequence diagrams, which render no `g.node` groups.
 */
export function countMermaidNodeDeclarations(text: string): number | null {
  switch (grammarFor(text)) {
    case "flowchart":
      return countFlowchartNodeIds(text);
    case "sequence":
      return 0;
    case "state":
      return countStateNodeGroups(text);
    case "unavailable":
      return null;
  }
}
