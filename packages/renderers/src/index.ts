import type { JsonValue } from "@mcp-inspector-x/protocol";

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
