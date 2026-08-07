#!/usr/bin/env bun
//
// Verifies ADR 0001 is complete: every D1..D6 heading is present exactly
// once, and each one carries a resolved `Decision:` line (never `OPEN`).
// Prints the per-decision state, then a single summary line.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DOC_PATH = resolve("docs/decisions/0001-build-inputs.md");
const REQUIRED_IDS = ["D1", "D2", "D3", "D4", "D5", "D6"] as const;
type DecisionId = (typeof REQUIRED_IDS)[number];

interface ParseResult {
  ids: Map<DecisionId, { resolved: boolean; line: number }>;
  duplicateHeadings: string[];
  openLine: number | null;
}

function parseDoc(text: string): ParseResult {
  const ids = new Map<DecisionId, { resolved: boolean; line: number }>();
  const headingCounts = new Map<string, number>();
  const duplicateHeadings: string[] = [];

  let currentHeading: string | null = null;
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const heading = line.match(/^##\s+(D\d+)\s*:/);
    if (heading) {
      const id = heading[1]!;
      headingCounts.set(id, (headingCounts.get(id) ?? 0) + 1);
      if (headingCounts.get(id) === 2) duplicateHeadings.push(id);
      currentHeading = id;
      continue;
    }

    if (currentHeading && (REQUIRED_IDS as readonly string[]).includes(currentHeading)) {
      const decisionLine = line.match(/^Decision:\s*(.*)$/);
      if (decisionLine) {
        const value = decisionLine[1]?.trim() ?? "";
        if (value === "OPEN") {
          return { ids, duplicateHeadings, openLine: lineNo };
        }
        const id = currentHeading as DecisionId;
        ids.set(id, { resolved: true, line: lineNo });
      }
    }
  }

  return { ids, duplicateHeadings, openLine: null };
}

function main(): number {
  const raw = readFileSync(DOC_PATH, "utf8");
  const result = parseDoc(raw);

  for (const id of REQUIRED_IDS) {
    const entry = result.ids.get(id);
    if (entry) {
      console.log(`${id} resolved`);
    } else {
      console.error(`${id} missing Decision line`);
      return 1;
    }
  }

  if (result.openLine !== null) {
    console.error(`OPEN Decision line found in ${DOC_PATH}`);
    return 1;
  }

  for (const dup of result.duplicateHeadings) {
    console.error(`Duplicate heading: ${dup}`);
    return 1;
  }

  console.log(`${REQUIRED_IDS.length} decisions resolved`);
  return 0;
}

process.exit(main());
