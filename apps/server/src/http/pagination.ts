/**
 * Cursor pagination (`docs/API.md` sections 2 and 6).
 *
 * A collection endpoint answers `{"data": [...], "meta": {"request_id": ...,
 * "next_cursor": ...}}`, and the cursor is opaque. The codec lives in
 * `@reviewplane/protocol/platform` so that a Go consumer and the web
 * application agree with the server about what one contains; this module is the
 * server-side half: how a page is read out of PostgreSQL and how a caller's
 * cursor becomes a `WHERE` clause.
 *
 * Keyset pagination rather than `OFFSET`. An offset re-reads and discards every
 * row before the page, which grows with the collection, and — worse for a
 * product built on an append-only stream — it shifts when a row is inserted, so
 * a caller paging through a busy project would silently skip rows. A keyset
 * cursor names the last row seen, so a page is defined relative to the data
 * rather than to a count.
 */

import { decodeCursor, encodeCursor } from "@reviewplane/protocol/platform";

import { ApiError } from "../errors.ts";

/** Default page size when a caller names none. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Largest page a caller may ask for. */
export const MAX_PAGE_LIMIT = 200;

export interface PageRequest {
  readonly limit: number;
  /** The position after the last row of the previous page, or null. */
  readonly after: { readonly sortKey: string; readonly id: string } | null;
}

/**
 * Reads `limit` and `cursor` from a query string.
 *
 * A cursor this server did not produce is refused with `VALIDATION_FAILED`
 * rather than treated as the first page: answering with a different page would
 * make pagination lose rows without saying so.
 */
export function readPageRequest(query: unknown): PageRequest {
  const source = (query ?? {}) as { limit?: unknown; cursor?: unknown };

  let limit = DEFAULT_PAGE_LIMIT;
  if (source.limit !== undefined) {
    const parsed = Number(source.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      throw new ApiError(
        "VALIDATION_FAILED",
        `limit must be an integer between 1 and ${String(MAX_PAGE_LIMIT)}.`,
        { field: "limit" },
      );
    }
    limit = parsed;
  }

  if (source.cursor === undefined || source.cursor === "") return { limit, after: null };
  if (typeof source.cursor !== "string") {
    throw new ApiError("VALIDATION_FAILED", "cursor must be a string.", { field: "cursor" });
  }
  const decoded = decodeCursor(source.cursor);
  if (!decoded.ok) {
    throw new ApiError("VALIDATION_FAILED", "The cursor is not one this API issued.", {
      field: "cursor",
      reason: decoded.reason,
    });
  }
  return { limit, after: { sortKey: decoded.value.sort_key, id: decoded.value.id } };
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Absent on the last page (`docs/API.md` section 6). */
  readonly nextCursor: string | null;
}

/**
 * Turns `limit + 1` rows into a page and the cursor that follows it.
 *
 * Reading one extra row is how the endpoint knows whether another page exists
 * without a second count query, and it is why `next_cursor` is absent on the
 * last page rather than present and pointing at nothing.
 */
export function buildPage<T>(
  rows: readonly T[],
  request: PageRequest,
  key: (row: T) => { readonly sortKey: string; readonly id: string },
): Page<T> {
  if (rows.length <= request.limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, request.limit);
  const last = items[items.length - 1];
  if (last === undefined) return { items, nextCursor: null };
  const position = key(last);
  return {
    items,
    nextCursor: encodeCursor({ version: 1, sort_key: position.sortKey, id: position.id }),
  };
}

/** The `meta` block for a paginated response (`docs/API.md` section 6). */
export function pageMeta(
  requestId: string,
  nextCursor: string | null,
): { request_id: string; next_cursor?: string } {
  return nextCursor === null
    ? { request_id: requestId }
    : { request_id: requestId, next_cursor: nextCursor };
}
