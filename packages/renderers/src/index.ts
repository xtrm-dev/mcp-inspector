import type { JsonValue } from "@mcp-inspector-x/protocol";
import type { RendererKind, RendererMeta, RenderResult } from "./types";
import { isFlatObjectArray, isJsonPrimitive, isMcpContentBlockShape, isPlainObject } from "./shape";
import { renderJsonTree } from "./impl/json-tree";
import { renderJsonFormatted } from "./impl/json-formatted";
import { renderJsonRaw } from "./impl/json-raw";
import { renderTable } from "./impl/table";
import { renderToon } from "./impl/toon";
import { renderCsv } from "./impl/csv";
import { renderTsv } from "./impl/tsv";
import { renderNdjson } from "./impl/ndjson";
import { renderText } from "./impl/text";
import { renderMcpContentBlock } from "./impl/mcp-content-block";

export type { RendererKind, RendererMeta, RenderResult };

// ---- Legacy classifier surface — preserved as-is; other packages (apps/web)
// import these directly. The registry below is an extension, not a
// replacement. ----

export type RendererId = "table" | "json-tree" | "structured" | "toon" | "raw";

export interface ResultClassification {
  renderer: RendererId;
  alternatives: RendererId[];
  tabular: boolean;
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRecordArray(value: JsonValue): value is Array<Record<string, JsonValue>> {
  return Array.isArray(value) && value.length > 0 && value.every(isObject);
}

export function classifyResult(value: JsonValue, declaredFormat?: string): ResultClassification {
  if (declaredFormat?.toLowerCase() === "toon") {
    return { renderer: "toon", alternatives: ["structured", "raw"], tabular: false };
  }
  if (isRecordArray(value)) {
    return { renderer: "table", alternatives: ["json-tree", "raw"], tabular: true };
  }
  if (typeof value === "object" && value !== null) {
    return { renderer: "json-tree", alternatives: ["raw"], tabular: false };
  }
  return { renderer: "structured", alternatives: ["raw"], tabular: false };
}

// ---- Renderer registry ----

export interface RendererRegistry {
  available(): RendererKind[];
  describe(kind: RendererKind): RendererMeta;
  render(input: unknown, opts: { kind: RendererKind; hint?: string }): RenderResult;
  /** Upgrades classifyResult(): picks the best renderer kind for arbitrary input. */
  suggest(input: unknown): RendererKind;
}

const RENDER_FNS: Record<RendererKind, (input: unknown) => RenderResult> = {
  "json-tree": renderJsonTree,
  "json-formatted": renderJsonFormatted,
  "json-raw": renderJsonRaw,
  table: renderTable,
  toon: renderToon,
  csv: renderCsv,
  tsv: renderTsv,
  ndjson: renderNdjson,
  text: renderText,
  "mcp-content-block": renderMcpContentBlock,
};

const META: Record<RendererKind, RendererMeta> = {
  "json-tree": {
    kind: "json-tree",
    label: "JSON Tree",
    mimeHint: "application/json",
    supportsShape: () => true,
  },
  "json-formatted": {
    kind: "json-formatted",
    label: "Formatted JSON",
    mimeHint: "application/json",
    supportsShape: () => true,
  },
  "json-raw": {
    kind: "json-raw",
    label: "Raw JSON",
    mimeHint: "application/json",
    supportsShape: () => true,
  },
  table: {
    kind: "table",
    label: "Table",
    mimeHint: "text/markdown",
    supportsShape: isFlatObjectArray,
  },
  toon: {
    kind: "toon",
    label: "TOON",
    mimeHint: "text/plain",
    supportsShape: isFlatObjectArray,
  },
  csv: {
    kind: "csv",
    label: "CSV",
    mimeHint: "text/csv",
    supportsShape: isFlatObjectArray,
  },
  tsv: {
    kind: "tsv",
    label: "TSV",
    mimeHint: "text/tab-separated-values",
    supportsShape: isFlatObjectArray,
  },
  ndjson: {
    kind: "ndjson",
    label: "NDJSON",
    mimeHint: "application/x-ndjson",
    supportsShape: (v) => Array.isArray(v) || isPlainObject(v),
  },
  text: {
    kind: "text",
    label: "Text",
    mimeHint: "text/plain",
    supportsShape: () => true,
  },
  "mcp-content-block": {
    kind: "mcp-content-block",
    label: "MCP Content Block",
    mimeHint: "application/json",
    supportsShape: isMcpContentBlockShape,
  },
};

const ALL_KINDS: RendererKind[] = Object.keys(RENDER_FNS) as RendererKind[];

// Lazy heuristic threshold for "large array of primitives" -> ndjson.
// Bump if real-world payloads suggest a different cutoff.
const LARGE_PRIMITIVE_ARRAY_THRESHOLD = 20;

function suggestKind(input: unknown): RendererKind {
  if (isMcpContentBlockShape(input)) return "mcp-content-block";
  if (isFlatObjectArray(input)) return "table";
  if (
    Array.isArray(input) &&
    input.length > LARGE_PRIMITIVE_ARRAY_THRESHOLD &&
    input.every(isJsonPrimitive)
  ) {
    return "ndjson";
  }
  return "json-tree";
}

export function createRendererRegistry(): RendererRegistry {
  return {
    available: () => [...ALL_KINDS],
    describe: (kind) => META[kind],
    render: (input, opts) => {
      const fn = RENDER_FNS[opts.kind];
      try {
        return fn(input);
      } catch (err) {
        return { ok: false, kind: opts.kind, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    suggest: suggestKind,
  };
}
