import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  mergeChatMessages,
  mapEngineHistoryMessage,
  updateMessageById,
  removeMessageById,
  type ChatMessageView,
} from '../utils/chatMessages.ts';
import { upsertIntoPages, nextMessagePageParam, type MessagePage } from '../utils/messagePages.ts';
import { sessionApi } from '../services/api.ts';

export type MessagesQueryKey = readonly ['messages', string, string];

export function messagesQueryKey(sessionId: string, chatId: string): MessagesQueryKey {
  return ['messages', sessionId, chatId] as const;
}

/** How many DB rows one page asks for. The gateway clamps `limit` to 100, so this is its maximum. */
export const MESSAGE_PAGE_SIZE = 100;

export type MessagesData = InfiniteData<MessagePage>;

/**
 * Fetch a chat's messages a page at a time, newest page first, cached at staleTime: Infinity;
 * realtime updates flow through useChatMessagesActions, not refetches.
 *
 * Engine history comes with the first page only — it is a one-shot backfill of a thread the gateway
 * never captured, with no cursor to page through. Fetched without media to keep the cache small; the
 * DB copy wins in mergeChatMessages, so recent media still renders.
 */
export function useChatMessages(
  sessionId: string,
  chatId: string | null,
): UseInfiniteQueryResult<ChatMessageView[], Error> {
  return useInfiniteQuery<MessagePage, Error, ChatMessageView[], MessagesQueryKey, number>({
    queryKey: messagesQueryKey(sessionId, chatId ?? ''),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const wantsHistory = pageParam === 0;
      const [dbRes, historyRes] = await Promise.allSettled([
        sessionApi.getChatMessages(sessionId, chatId!, MESSAGE_PAGE_SIZE, pageParam),
        wantsHistory ? sessionApi.getChatHistory(sessionId, chatId!, 100, false) : Promise.resolve([]),
      ]);
      // Only the first page may fall back to history alone; an older page has no second source, so a
      // rejected DB read there is a real failure and must surface rather than resolve to an empty
      // page that would read as "no more messages".
      if (dbRes.status === 'rejected' && (!wantsHistory || historyRes.status === 'rejected')) throw dbRes.reason;
      const db = dbRes.status === 'fulfilled' ? dbRes.value : { messages: [], total: 0 };
      const history = historyRes.status === 'fulfilled' ? historyRes.value.map(mapEngineHistoryMessage) : [];
      return { db: db.messages, history, total: db.total };
    },
    getNextPageParam: (_lastPage, allPages) => nextMessagePageParam(allPages),
    // Consumers keep seeing one flat chronological list; paging stays inside the cache.
    select: data =>
      mergeChatMessages(
        data.pages.flatMap(page => page.db),
        data.pages.flatMap(page => page.history),
      ),
    enabled: Boolean(sessionId && chatId),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Apply a list transform to every cached page. Both arrays are transformed: a message the gateway
 * never persisted exists only in `history`, so touching `db` alone would drop its edits and deletes.
 */
function mapCachedMessages(
  queryClient: QueryClient,
  key: MessagesQueryKey,
  transform: (list: ChatMessageView[]) => ChatMessageView[],
): void {
  queryClient.setQueryData<MessagesData>(key, old =>
    old === undefined
      ? undefined
      : {
          ...old,
          pages: old.pages.map(page => ({
            ...page,
            db: transform(page.db),
            history: transform(page.history),
          })),
        },
  );
}

/**
 * Edit one chat's cached messages from outside this module, without the call site having to know
 * the paged cache shape: it hands over a plain list transform.
 */
export function updateCachedMessages(
  queryClient: QueryClient,
  key: MessagesQueryKey,
  transform: (list: ChatMessageView[]) => ChatMessageView[],
): void {
  mapCachedMessages(queryClient, key, transform);
}

/**
 * Insert or merge one message, optionally dropping an optimistic placeholder by id.
 *
 * Which page receives it matters: `mergeOrAppend` appends when it finds no match, so running it
 * over every page would add a copy to each one. The message is merged into the page that already
 * holds it, and only lands on the newest page when no page does.
 */
export function upsertCachedMessage(
  queryClient: QueryClient,
  key: MessagesQueryKey,
  incoming: ChatMessageView,
  options: { dropId?: string } = {},
): void {
  queryClient.setQueryData<MessagesData>(key, old =>
    old === undefined || old.pages.length === 0
      ? undefined
      : { ...old, pages: upsertIntoPages(old.pages, incoming, options.dropId) },
  );
}

/**
 * Mutation helpers that write directly to the React Query cache. Use these
 * from the WebSocket subscriber, the optimistic-send flow, and ACK handlers
 * instead of calling setMessages locally.
 */
export function useChatMessagesActions() {
  const qc = useQueryClient();

  return {
    appendMessage(sessionId: string, chatId: string, msg: ChatMessageView) {
      // Only writes to a slice that already exists. Seeding one for a never-opened chat would be
      // "fresh" under staleTime: Infinity, so opening the chat would skip the queryFn and show this
      // message alone.
      upsertCachedMessage(qc, messagesQueryKey(sessionId, chatId), msg);
    },
    updateMessage(sessionId: string, chatId: string, id: string, patch: Partial<ChatMessageView>) {
      mapCachedMessages(qc, messagesQueryKey(sessionId, chatId), list => updateMessageById(list, id, patch));
    },
    removeMessage(sessionId: string, chatId: string, id: string) {
      mapCachedMessages(qc, messagesQueryKey(sessionId, chatId), list => removeMessageById(list, id));
    },
  };
}
