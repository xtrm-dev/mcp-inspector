import { useRef, useState, type CSSProperties } from "react";

export interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  height: number;
  hasMore: boolean;
  onNeedMore: () => void;
  renderRow: (item: T, index: number) => React.ReactNode;
}

/**
 * Minimal fixed-row-height virtualized list: only renders the rows in (and
 * just around) the visible scroll window, and asks for more data when the
 * user scrolls near the bottom. Rolled by hand rather than pulling in
 * react-window/react-virtual — one scroll handler covers this slice's needs
 * (a flat row list) and the bead's no-new-CSS-framework / minimal-deps
 * posture argues against a dependency for that.
 */
export function VirtualList<T>({ items, rowHeight, height, hasMore, onNeedMore, renderRow }: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const requestedRef = useRef(false);

  const overscan = 4;
  const visibleCount = Math.ceil(height / rowHeight) + overscan * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(items.length, startIndex + visibleCount);
  const topSpacer = startIndex * rowHeight;
  const bottomSpacer = Math.max(0, (items.length - endIndex) * rowHeight);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight * 3;
    if (nearBottom && hasMore && !requestedRef.current) {
      requestedRef.current = true;
      onNeedMore();
    }
  }

  // Reset the "in-flight" guard once new items actually arrive.
  if (requestedRef.current && items.length > 0) {
    requestedRef.current = false;
  }

  const containerStyle: CSSProperties = { height, overflowY: "auto", position: "relative" };

  return (
    <div className="virtual-list" style={containerStyle} onScroll={handleScroll} data-testid="virtual-list">
      <div style={{ height: topSpacer }} />
      {items.slice(startIndex, endIndex).map((item, i) => (
        <div key={startIndex + i} style={{ height: rowHeight }}>
          {renderRow(item, startIndex + i)}
        </div>
      ))}
      <div style={{ height: bottomSpacer }} />
    </div>
  );
}
