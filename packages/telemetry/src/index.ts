import type { SourceGraph } from "@mcp-inspector-x/source-intelligence";

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: string;
  durationMs: number;
  status: "unset" | "ok" | "error";
  sourceSymbolId?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface CorrelatedSourceNode {
  sourceSymbolId: string;
  runtime: boolean;
  spans: TraceSpan[];
}

export function correlateTraceToSource(graph: SourceGraph, spans: TraceSpan[]): CorrelatedSourceNode[] {
  const bySymbol = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    if (!span.sourceSymbolId) continue;
    const current = bySymbol.get(span.sourceSymbolId) ?? [];
    current.push(span);
    bySymbol.set(span.sourceSymbolId, current);
  }
  return graph.symbols.map((symbol) => ({
    sourceSymbolId: symbol.id,
    runtime: bySymbol.has(symbol.id),
    spans: bySymbol.get(symbol.id) ?? [],
  }));
}
