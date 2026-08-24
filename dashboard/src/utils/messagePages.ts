import { mergeOrAppend, type ChatMessageView } from './chatMessages.ts';

/**
 * One fetched slice of a chat's history. `db` and `history` stay separate because the page cursor is
 * the number of DB rows fetched, and merging first loses that count — the merged list adds engine
 * history items and drops the duplicates between the two sources.
 */
export interface MessagePage {
  db: ChatMessageView[];
  history: ChatMessageView[];
  /** Total DB rows for this chat (getManyAndCount) — says whether an older page exists. */
  total: number;
}

/** DB rows fetched across every page so far — the offset the next page asks for. */
export function dbRowsFetched(pages: MessagePage[]): number {
  return pages.reduce((count, page) => count + page.db.length, 0);
}

/**
 * Offset of the next older page, or undefined once the chat's rows are covered.
 *
 * Counting DB rows, not merged/rendered ones: the merged list carries engine-history items too, so
 * paging by its length would step the cursor past rows that were never read.
 */
export function nextMessagePageParam(pages: MessagePage[]): number | undefined {
  const fetched = dbRowsFetched(pages);
  const total = pages[pages.length - 1]?.total ?? 0;
  return fetched < total ? fetched : undefined;
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
