import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMappedSenders, isSenderMapped } from './mappedSenders.ts';

const senders = buildMappedSenders([
  { jid: '9198@c.us', name: 'Palak Srivastava', aliasJids: ['72627@lid'] },
  { jid: '5555@c.us', name: 'Ravi', aliasJids: null },
]);

test('a sender is mapped by its primary jid', () => {
  assert.equal(isSenderMapped(senders, '9198@c.us', 'x'), true);
});

test('a sender is mapped by a recorded alias jid', () => {
  assert.equal(isSenderMapped(senders, '72627@lid', undefined), true);
});

test('a sender with an unknown jid is mapped when the display name matches exactly, ignoring case and spacing', () => {
  assert.equal(isSenderMapped(senders, '999@lid', '  palak   SRIVASTAVA '), true);
});

test('an unknown jid with an unknown or blank name is not mapped', () => {
  assert.equal(isSenderMapped(senders, '999@lid', 'Someone Else'), false);
  assert.equal(isSenderMapped(senders, '999@lid', ' '), false);
  assert.equal(isSenderMapped(senders, '999@lid', undefined), false);
});

test('a partial name does not count', () => {
  assert.equal(isSenderMapped(senders, '999@lid', 'Palak'), false);
});
