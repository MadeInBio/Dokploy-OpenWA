import { mergeOrAppendUncapped, type ChatMessageView } from './chatMessages.ts';

/**
 * One fetched slice of a chat's history. `db` and `history` stay separate because the page cursor is
 * the number of DB rows fetched, and merging first loses that count — the merged list adds engine
 * history items and drops the duplicates between the two sources.
 */
export interface MessagePage {
  db: ChatMessageView[];
  history: ChatMessageView[];
  /**
   * Rows this page's fetch RETURNED, recorded before any live arrival is merged in. `db.length`
   * drifts upward as messages land in page 0, which is why termination cannot be read from it.
   */
  fetched: number;
}

/**
 * Optimistic-send placeholders (ChatComposer's `temp_${Date.now()}` id) never reached the DB. One
 * that failed stays in `page.db` with `status: 'failed'` and nothing ever removes it, so counting
 * it as a fetched row would offset every later page by one and strand a real row unreachable.
 * Matched on the id prefix specifically — not on a missing `waMessageId`, which is nullable on a
 * genuine DB row too.
 */
const isOptimisticPlaceholder = (m: ChatMessageView): boolean => m.id.startsWith('temp_');

/** DB rows fetched across every page so far — the offset the next page asks for. */
export function dbRowsFetched(pages: MessagePage[]): number {
  return pages.reduce((count, page) => count + page.db.filter(m => !isOptimisticPlaceholder(m)).length, 0);
}

/**
 * Offset of the next older page, or undefined once the oldest page came back short.
 *
 * The offset counts DB rows including live arrivals — each server insert shifts the window by one,
 * and rendered length would count engine-history items the DB never returned. Termination cannot
 * use that same growing count against the chat's frozen row total, which meets it a few live
 * messages early and strands the oldest rows.
 */
export function nextMessagePageParam(pages: MessagePage[], pageSize: number): number | undefined {
  const oldest = pages[pages.length - 1];
  if (oldest === undefined || oldest.fetched < pageSize) return undefined;
  return dbRowsFetched(pages);
}

const messageKey = (m: ChatMessageView): string => m.waMessageId ?? m.id;

/**
 * Insert or merge one message, optionally dropping an optimistic placeholder by id.
 *
 * Which page receives it matters: a plain append (finding no match) would add a copy to every page
 * run this way, so the message is merged into the page that already holds it, landing on the newest
 * page only when no page does. Uses the uncapped merge deliberately: `page.db` is server order
 * (`createdAt DESC`, newest first), and the payload cap strips from the front of an ASCENDING list —
 * on this order it would strip the newest payloads first. The real cap already runs once, correctly
 * ordered, on the flattened thread `select` produces; capping each page too would be redundant even
 * pointed the right way, since one page rarely nears MEDIA_PAYLOAD_CACHE_LIMIT on its own.
 */
export function upsertIntoPages(pages: MessagePage[], incoming: ChatMessageView, dropId?: string): MessagePage[] {
  const trimmed = dropId
    ? pages.map(page => ({
        ...page,
        db: page.db.filter(m => m.id !== dropId),
        history: page.history.filter(m => m.id !== dropId),
      }))
    : pages;
  const target = trimmed.findIndex(page => page.db.some(m => messageKey(m) === messageKey(incoming)));
  const index = target === -1 ? 0 : target;
  return trimmed.map((page, i) => (i === index ? { ...page, db: mergeOrAppendUncapped(page.db, incoming) } : page));
}
