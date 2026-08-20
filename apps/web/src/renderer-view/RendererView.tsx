import { useEffect, useState } from "react";
import { getArtifactPage, listRenderers } from "../api/client";
import type { JsonValue, RendererDescriptor, RendererKind } from "../api/types";
import { ALL_RENDERER_KINDS, renderInline } from "./render-kinds";
import { VirtualList } from "./VirtualList";

export interface RendererViewProps {
  /** Inline JSON result (≤16KiB per the gateway's inline/artifact split), already parsed. */
  value?: JsonValue | undefined;
  /** Artifact hash the gateway spilled the result to when it exceeded the inline threshold. */
  resultArtifact?: string | null;
  suggestedRenderer?: RendererKind | undefined;
}

const PAGE_SIZE = 200;
const ROW_HEIGHT = 22;
const VIEWPORT_HEIGHT = 320;

/**
 * Renders a tool/resource/prompt result using the suggested renderer kind,
 * with an alternatives picker sourced from GET /api/v1/renderers. Small
 * results render inline; results the gateway spilled to an artifact (>16KiB)
 * are paged + virtualized via GET /api/v1/artifacts/:sha/page so the UI
 * never has to hold the whole payload in the DOM at once.
 */
export function RendererView({ value, resultArtifact, suggestedRenderer }: RendererViewProps) {
  const [kind, setKind] = useState<RendererKind>(suggestedRenderer ?? "json-tree");
  const [descriptors, setDescriptors] = useState<RendererDescriptor[]>(
    ALL_RENDERER_KINDS.map((k) => ({ kind: k, label: k })),
  );

  useEffect(() => {
    let cancelled = false;
    listRenderers()
      .then((res) => {
        if (!cancelled && res.renderers.length > 0) setDescriptors(res.renderers);
      })
      .catch(() => {
        // Registry endpoint not reachable (e.g. pre-merge / offline dev) —
        // keep the static fallback list so the picker still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (suggestedRenderer) setKind(suggestedRenderer);
  }, [suggestedRenderer]);

  return (
    <div className="renderer-view">
      <div className="renderer-picker">
        {descriptors.map((d) => (
          <button key={d.kind} className={d.kind === kind ? "active" : ""} onClick={() => setKind(d.kind)}>
            {d.label}
          </button>
        ))}
      </div>
      {resultArtifact ? (
        <PagedRenderer artifactRef={resultArtifact} kind={kind} />
      ) : (
        <pre className="renderer-inline">{value !== undefined ? renderInline(value, kind) : "(no result)"}</pre>
      )}
    </div>
  );
}

function PagedRenderer({ artifactRef, kind }: { artifactRef: string; kind: RendererKind }) {
  const [lines, setLines] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reset paging state whenever the artifact or chosen kind changes.
  useEffect(() => {
    setLines([]);
    setOffset(0);
    setHasMore(true);
    setError(null);
  }, [artifactRef, kind]);

  useEffect(() => {
    if (offset !== 0 || lines.length > 0) return;
    loadPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactRef, kind]);

  function loadPage(nextOffset: number) {
    getArtifactPage(artifactRef, { offset: nextOffset, limit: PAGE_SIZE, kind })
      .then((page) => {
        setLines((prev) => [...prev, ...page.lines]);
        setOffset(page.offset + page.lines.length);
        setHasMore(page.hasMore);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  if (error) return <p className="form-error">{error}</p>;

  return (
    <VirtualList
      items={lines}
      rowHeight={ROW_HEIGHT}
      height={VIEWPORT_HEIGHT}
      hasMore={hasMore}
      onNeedMore={() => loadPage(offset)}
      renderRow={(line) => <div className="renderer-row">{line}</div>}
    />
  );
}
