import { useState } from 'react';

export const PAGE_SIZE = 100;

/** Splits long tables into pages so big meshes stay responsive. */
export function usePage<T>(rows: readonly T[], size = PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages - 1);
  return {
    rows: rows.slice(current * size, (current + 1) * size),
    pager:
      pages > 1 ? (
        <div className="pager" role="navigation" aria-label="Table pages">
          <button
            type="button"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span>
            Rows {current * size + 1}–{Math.min(rows.length, (current + 1) * size)} of {rows.length}
          </span>
          <button
            type="button"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      ) : null,
  };
}
