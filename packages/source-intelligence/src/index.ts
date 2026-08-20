export interface SourceRevision {
  repository: string;
  commitSha: string;
  deploymentId?: string;
  sourceIndexVersion?: string;
}

export type SourceEvidence = "static" | "runtime-confirmed" | "metadata";

export interface SourceSymbol {
  id: string;
  repository: string;
  path: string;
  symbol: string;
  startLine?: number;
  endLine?: number;
}

export interface SourceEdge {
  from: string;
  to: string;
  evidence: SourceEvidence;
  relation: "calls" | "imports" | "registers" | "queries" | "renders" | "depends-on";
}

export interface SourceGraph {
  revision: SourceRevision;
  rootSymbolId: string;
  symbols: SourceSymbol[];
  edges: SourceEdge[];
}

export type CodeViewMode = "snippet" | "symbol" | "file";

export interface SourceCodeRequest {
  revision: SourceRevision;
  symbolId: string;
  mode: CodeViewMode;
}

// ---------- Capability -> handler map ingest (Phase M slice 3) ----------
//
// This is an ingest contract only: the caller (operator tooling, or a later
// repo indexer per ADR-0003 23.2) supplies the capability->handler mapping.
// No repo checkout / symbol resolution happens here.

export type CapabilityMappingKind = "tool" | "resource" | "prompt";

const CAPABILITY_MAPPING_KINDS: readonly CapabilityMappingKind[] = ["tool", "resource", "prompt"];

export interface SourceMappingEntry {
  capabilityId: string;
  kind: CapabilityMappingKind;
  handlerSymbol: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet?: string;
}

export interface MappingEntryValidationError {
  index: number;
  message: string;
}

export type ParseMappingEntryResult =
  | { ok: true; entry: SourceMappingEntry }
  | { ok: false; error: MappingEntryValidationError };

/** Validate + normalize one raw ingest entry from an untrusted request body. */
export function parseSourceMappingEntry(raw: unknown, index: number): ParseMappingEntryResult {
  const fail = (message: string): ParseMappingEntryResult => ({ ok: false, error: { index, message } });

  if (typeof raw !== "object" || raw === null) return fail("entry must be an object");
  const r = raw as Record<string, unknown>;

  if (typeof r.capabilityId !== "string" || r.capabilityId.length === 0) {
    return fail("'capabilityId' (string) required");
  }
  if (typeof r.kind !== "string" || !CAPABILITY_MAPPING_KINDS.includes(r.kind as CapabilityMappingKind)) {
    return fail("'kind' must be one of tool|resource|prompt");
  }
  if (typeof r.handlerSymbol !== "string" || r.handlerSymbol.length === 0) {
    return fail("'handlerSymbol' (string) required");
  }
  if (typeof r.filePath !== "string" || r.filePath.length === 0) {
    return fail("'filePath' (string) required");
  }
  if (typeof r.lineStart !== "number" || !Number.isInteger(r.lineStart) || r.lineStart < 1) {
    return fail("'lineStart' (positive integer) required");
  }
  if (typeof r.lineEnd !== "number" || !Number.isInteger(r.lineEnd) || r.lineEnd < r.lineStart) {
    return fail("'lineEnd' (integer >= lineStart) required");
  }
  if (r.snippet !== undefined && typeof r.snippet !== "string") {
    return fail("'snippet' must be a string when present");
  }

  const entry: SourceMappingEntry = {
    capabilityId: r.capabilityId,
    kind: r.kind as CapabilityMappingKind,
    handlerSymbol: r.handlerSymbol,
    filePath: r.filePath,
    lineStart: r.lineStart,
    lineEnd: r.lineEnd,
  };
  if (typeof r.snippet === "string") entry.snippet = r.snippet;
  return { ok: true, entry };
}

// ---------- Bounded snippet trimming ----------

export const SOURCE_SNIPPET_MAX_LINES = 40;

export interface TrimmedSnippet {
  text: string;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
}

/**
 * Bound a snippet to at most `maxLines` lines, keeping a head and tail
 * window around a single omission marker when the snippet is longer. Line
 * numbers in both the returned range and the marker are the real
 * file line numbers (anchored at `lineStart`), never a re-based 1..N.
 */
export function trimSnippet(
  snippet: string,
  lineStart: number,
  maxLines: number = SOURCE_SNIPPET_MAX_LINES,
): TrimmedSnippet {
  const lines = snippet.split("\n");
  const lineEnd = lineStart + lines.length - 1;

  if (lines.length <= maxLines) {
    return { text: snippet, lineStart, lineEnd, truncated: false };
  }

  // Reserve one line of the budget for the omission marker itself.
  const contentBudget = Math.max(maxLines - 1, 2);
  const headCount = Math.ceil(contentBudget / 2);
  const tailCount = Math.floor(contentBudget / 2);
  const head = lines.slice(0, headCount);
  const tail = lines.slice(lines.length - tailCount);

  const omittedFirst = lineStart + headCount;
  const omittedLast = lineEnd - tailCount;
  const marker = `… ${omittedLast - omittedFirst + 1} lines omitted (L${omittedFirst}-L${omittedLast}) …`;

  return { text: [...head, marker, ...tail].join("\n"), lineStart, lineEnd, truncated: true };
}
