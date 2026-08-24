import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbRowsFetched, nextMessagePageParam, upsertIntoPages, type MessagePage } from './messagePages.ts';
import type { ChatMessageView } from './chatMessages.ts';

const msg = (id: string, extra: Partial<ChatMessageView> = {}): ChatMessageView =>
  ({
    id,
    waMessageId: id,
    chatId: 'c1',
    body: id,
    type: 'text',
    direction: 'incoming',
    status: 'read',
    timestamp: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }) as ChatMessageView;

const page = (db: ChatMessageView[], total: number, history: ChatMessageView[] = []): MessagePage => ({
  db,
  history,
  total,
});

test('the cursor counts DB rows, not the rendered merge', () => {
  // The regression this guards: engine history inflates the rendered list, so paging by its length
  // would ask for an offset past rows the DB read never returned — silently skipping them.
  const pages = [page([msg('a'), msg('b')], 10, [msg('h1'), msg('h2'), msg('h3')])];

  assert.equal(dbRowsFetched(pages), 2);
  assert.equal(nextMessagePageParam(pages), 2);
});

test('the cursor accumulates across pages', () => {
  const pages = [page([msg('a'), msg('b')], 10), page([msg('c')], 10)];

  assert.equal(nextMessagePageParam(pages), 3);
});

test('paging stops once the chat total is covered', () => {
  assert.equal(nextMessagePageParam([page([msg('a'), msg('b')], 2)]), undefined);
});

test('paging stops on an empty chat rather than asking for offset 0 forever', () => {
  assert.equal(nextMessagePageParam([page([], 0)]), undefined);
});

test('a live message lands on the newest page', () => {
  const pages = [page([msg('new')], 3), page([msg('old')], 3)];

  const result = upsertIntoPages(pages, msg('live'));

  assert.deepEqual(
    result[0].db.map(m => m.id),
    ['new', 'live'],
  );
  assert.deepEqual(
    result[1].db.map(m => m.id),
    ['old'],
  );
});

test('a message already held by an older page is merged there, not duplicated', () => {
  // mergeOrAppend appends when it finds no match, so running it over every page would leave one
  // copy per page. An ack for an old message must update it where it lives.
  const pages = [page([msg('new')], 3), page([msg('old', { status: 'sent' })], 3)];

  const result = upsertIntoPages(pages, msg('old', { status: 'read' }));

  assert.equal(result.flatMap(p => p.db).filter(m => m.id === 'old').length, 1);
  assert.equal(result[0].db.length, 1);
  assert.equal(result[1].db[0].status, 'read');
});

test('an optimistic placeholder is dropped from whichever page holds it', () => {
  const pages = [page([msg('tmp-1')], 2)];

  const result = upsertIntoPages(pages, msg('real-1'), 'tmp-1');

  assert.deepEqual(
    result.flatMap(p => p.db).map(m => m.id),
    ['real-1'],
  );
});

test('the placeholder is dropped even when the echo already arrived on its own', () => {
  // The send response and the realtime echo race: if the echo won, the placeholder must still go,
  // and its payload must fold into the echo rather than leaving two bubbles.
  const pages = [page([msg('tmp-1'), msg('real-1')], 2)];

  const result = upsertIntoPages(pages, msg('real-1', { status: 'sent' }), 'tmp-1');

  assert.deepEqual(
    result.flatMap(p => p.db).map(m => m.id),
    ['real-1'],
  );
});
