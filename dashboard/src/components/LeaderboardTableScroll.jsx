import React, { useLayoutEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";

/** Keep horizontal navigation reachable above long leaderboard tables. */
export function LeaderboardTableScroll({ children }) {
  const topRef = useRef(null);
  const tableRef = useRef(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const [hasOverflow, setHasOverflow] = useState(false);

  useLayoutEffect(() => {
    const viewport = tableRef.current;
    const measure = () => {
      setScrollWidth(viewport.scrollWidth);
      setHasOverflow(viewport.scrollWidth > viewport.clientWidth);
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(viewport);
    observer?.observe(viewport.firstElementChild);
    return () => observer?.disconnect();
  }, []);

  useLayoutEffect(() => {
    topRef.current.scrollLeft = tableRef.current.scrollLeft;
  }, [scrollWidth]);

  return (
    <div className="hidden w-full sm:block">
      <div
        ref={topRef}
        hidden={!hasOverflow}
        role="region"
        aria-label={copy("leaderboard.horizontal_scroll")}
        tabIndex={0}
        className="oai-scrollbar h-4 w-full overflow-x-auto overflow-y-hidden border-b border-oai-gray-200 dark:border-oai-gray-800 [scrollbar-gutter:auto]"
        onScroll={(event) => { tableRef.current.scrollLeft = event.currentTarget.scrollLeft; }}
      >
        <div style={{ width: scrollWidth, height: 1 }} />
      </div>
      <div
        ref={tableRef}
        className="oai-scrollbar w-full overflow-x-auto [scrollbar-gutter:auto]"
        onScroll={(event) => { topRef.current.scrollLeft = event.currentTarget.scrollLeft; }}
      >
        {children}
      </div>
    </div>
  );
}
