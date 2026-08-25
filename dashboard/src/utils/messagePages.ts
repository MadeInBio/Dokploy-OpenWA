import { mergeOrAppend, type ChatMessageView } from './chatMessages.ts';

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

/** DB rows fetched across every page so far — the offset the next page asks for. */
export function dbRowsFetched(pages: MessagePage[]): number {
  return pages.reduce((count, page) => count + page.db.length, 0);
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
 * Which page receives it matters: `mergeOrAppend` appends when it finds no match, so running it over
 * every page would add a copy to each one. The message is merged into the page that already holds
 * it, and only lands on the newest page when no page does.
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
  return trimmed.map((page, i) => (i === index ? { ...page, db: mergeOrAppend(page.db, incoming) } : page));
}
