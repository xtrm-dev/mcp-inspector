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
