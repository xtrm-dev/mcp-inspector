import type { JsonSchema, McpPromptArgumentDefinition } from "../api/types";

export interface SchemaSummaryProps {
  schema?: JsonSchema | null | undefined;
  arguments?: McpPromptArgumentDefinition[] | null | undefined;
}

interface Row {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

function typeLabel(propSchema: unknown): string {
  if (!propSchema || typeof propSchema !== "object") return "any";
  const t = (propSchema as { type?: unknown }).type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.filter((x) => typeof x === "string").join(" | ") || "any";
  return "any";
}

function descriptionOf(propSchema: unknown): string | null {
  if (!propSchema || typeof propSchema !== "object") return null;
  const d = (propSchema as { description?: unknown }).description;
  return typeof d === "string" && d.length > 0 ? d : null;
}

function rowsFromSchema(schema: JsonSchema): Row[] {
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return [];
  const requiredRaw = (schema as { required?: unknown }).required;
  const required = Array.isArray(requiredRaw)
    ? new Set(requiredRaw.filter((x): x is string => typeof x === "string"))
    : new Set<string>();
  return Object.entries(properties as Record<string, unknown>).map(([name, propSchema]) => ({
    name,
    type: typeLabel(propSchema),
    required: required.has(name),
    description: descriptionOf(propSchema),
  }));
}

function rowsFromArguments(args: McpPromptArgumentDefinition[]): Row[] {
  return args.map((a) => ({
    name: a.name,
    type: "string",
    required: Boolean(a.required),
    description: a.description ?? null,
  }));
}

export function SchemaSummary({ schema, arguments: args }: SchemaSummaryProps) {
  const rows: Row[] = args && args.length > 0 ? rowsFromArguments(args) : schema ? rowsFromSchema(schema) : [];
  if (rows.length === 0) {
    return <span className="muted">—</span>;
  }
  return (
    <ul className="schema-summary" data-testid="schema-summary">
      {rows.map((r) => (
        <li key={r.name} className="schema-summary-row">
          <code className="schema-summary-name">{r.name}</code>
          <span className="schema-summary-type muted">({r.type}{r.required ? ", required" : ""})</span>
          {r.description ? <span className="schema-summary-desc"> — {r.description}</span> : null}
        </li>
      ))}
    </ul>
  );
}
