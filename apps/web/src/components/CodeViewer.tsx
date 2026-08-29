import { useEffect, useState } from "react";
import { getSourceCode } from "../api/client";
import type { SourceCodeResponse } from "../api/types";

// Stream E — CodeViewer panel. Six selectable sub-views over one bundled
// `/source/revisions/:id/code` payload: snippet / full symbol / full file /
// dependencies / dependents / runtime trace. No Monaco, no external editor;
// a plain `<pre>` with a line-number `<span>` gutter per the brief.

export type CodeViewMode =
  | "snippet"
  | "symbol"
  | "file"
  | "dependencies"
  | "dependents"
  | "trace";

const MODE_LABELS: Record<CodeViewMode, string> = {
  snippet: "Snippet",
  symbol: "Full symbol",
  file: "Full file",
  dependencies: "Dependencies",
  dependents: "Dependents",
  trace: "Runtime trace",
};

interface Props {
  revisionId: string;
  filePath: string;
  handlerSymbol: string;
  onNavigate?: (filePath: string, handlerSymbol: string) => void;
}

export function CodeViewer({ revisionId, filePath, handlerSymbol, onNavigate }: Props) {
  const [data, setData] = useState<SourceCodeResponse | null>(null);
  const [mode, setMode] = useState<CodeViewMode>("snippet");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    getSourceCode(revisionId, filePath, handlerSymbol)
      .then((r) => setData(r))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [revisionId, filePath, handlerSymbol]);

  return (
    <section className="code-viewer" data-testid="code-viewer">
      <header className="code-viewer-header">
        <h4 data-testid="code-viewer-title">
          {handlerSymbol}
          <span className="muted"> — {filePath}</span>
        </h4>
        <div className="projection-picker" role="tablist" aria-label="Code viewer sub-view">
          {(Object.keys(MODE_LABELS) as CodeViewMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`chip ${mode === m ? "chip-active" : ""}`}
              data-testid={`code-viewer-mode-${m}`}
              onClick={() => setMode(m)}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </header>
      {loading && <p className="muted">Loading code…</p>}
      {error && <p className="form-error" data-testid="code-viewer-error">{error}</p>}
      {data && !loading && !error && (
        <div className="code-viewer-body" data-testid={`code-viewer-body-${mode}`}>
          {renderMode(mode, data, onNavigate)}
        </div>
      )}
    </section>
  );
}

function renderMode(
  mode: CodeViewMode,
  data: SourceCodeResponse,
  onNavigate?: (filePath: string, handlerSymbol: string) => void,
) {
  if (mode === "snippet") {
    if (!data.snippet) return <p className="muted">No snippet available for this symbol.</p>;
    return (
      <NumberedCode
        text={data.snippet.text}
        startLine={data.snippet.lineStart}
        testId="code-viewer-snippet"
        footer={
          data.snippet.truncated
            ? `Trimmed to head + tail window (real lines L${data.snippet.lineStart}-L${data.snippet.lineEnd}).`
            : null
        }
      />
    );
  }
  if (mode === "symbol") {
    if (!data.symbolText) {
      return <p className="muted" data-testid="code-viewer-symbol-empty">Full symbol text was not indexed for this symbol.</p>;
    }
    return (
      <NumberedCode
        text={data.symbolText}
        startLine={data.symbol.lineStart}
        testId="code-viewer-symbol-text"
      />
    );
  }
  if (mode === "file") {
    if (!data.fileText) {
      return <p className="muted" data-testid="code-viewer-file-empty">Full file text was not indexed for this revision.</p>;
    }
    return (
      <NumberedCode
        text={data.fileText}
        startLine={1}
        testId="code-viewer-file-text"
      />
    );
  }
  if (mode === "dependencies") {
    if (data.dependencies.length === 0) {
      return <p className="muted" data-testid="code-viewer-deps-empty">No outgoing calls recorded for this symbol.</p>;
    }
    return (
      <ul className="code-viewer-list" data-testid="code-viewer-deps">
        {data.dependencies.map((d) => (
          <li key={d.symbolId}>
            <button
              className="link-button"
              type="button"
              data-testid={`code-viewer-dep-${d.symbolId}`}
              onClick={() => onNavigate?.(d.filePath, d.handlerSymbol)}
            >
              {d.handlerSymbol}
            </button>
            <span className="muted"> — {d.filePath}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (mode === "dependents") {
    if (data.dependents.length === 0) {
      return <p className="muted" data-testid="code-viewer-dependents-empty">No known callers of this symbol.</p>;
    }
    return (
      <ul className="code-viewer-list" data-testid="code-viewer-dependents">
        {data.dependents.map((d) => (
          <li key={d.symbolId}>
            <button
              className="link-button"
              type="button"
              data-testid={`code-viewer-dependent-${d.symbolId}`}
              onClick={() => onNavigate?.(d.filePath, d.handlerSymbol)}
            >
              {d.handlerSymbol}
            </button>
            <span className="muted"> — {d.filePath}</span>
          </li>
        ))}
      </ul>
    );
  }
  // trace
  if (data.trace.length === 0) {
    return <p className="muted" data-testid="code-viewer-trace-empty">No runtime observations for this symbol yet.</p>;
  }
  return (
    <ol className="code-viewer-trace" data-testid="code-viewer-trace">
      {data.trace.map((t) => (
        <li key={t.executionId} data-testid={`code-viewer-trace-${t.executionId}`}>
          <span className={`trace-status trace-status-${t.status}`}>{t.status}</span>
          <span> · {t.serverId} · {t.capabilityId}</span>
          <span className="muted"> — {t.startedAt}</span>
        </li>
      ))}
    </ol>
  );
}

interface NumberedCodeProps {
  text: string;
  startLine: number;
  testId: string;
  footer?: string | null;
}

function NumberedCode({ text, startLine, testId, footer }: NumberedCodeProps) {
  const lines = text.split("\n");
  return (
    <div className="code-viewer-code" data-testid={testId}>
      <pre className="code-viewer-pre">
        {lines.map((line, i) => (
          <div key={i} className="code-viewer-line">
            <span className="code-viewer-gutter">{startLine + i}</span>
            <span className="code-viewer-line-text">{line || " "}</span>
          </div>
        ))}
      </pre>
      {footer && <p className="muted code-viewer-footer">{footer}</p>}
    </div>
  );
}
