// Fork-only. Decides whether a group message's sender already has a Client Mapping, so Chats does not
// offer "add to mapping" for someone who exists. WhatsApp uses several jids for one person (phone jid,
// @lid), so matching only the primary jid missed people whose row is keyed by phone while their
// messages carry a @lid author. Recorded aliases and an exact display-name match count as mapped too.
import type { ClientMapping } from './clientMappingApi';

export interface MappedSenders {
  jids: Set<string>;
  names: Set<string>;
}

const normName = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function buildMappedSenders(mappings: Pick<ClientMapping, 'jid' | 'name' | 'aliasJids'>[]): MappedSenders {
  const jids = new Set<string>();
  const names = new Set<string>();
  for (const m of mappings) {
    jids.add(m.jid);
    for (const alias of m.aliasJids ?? []) jids.add(alias);
    if (m.name.trim()) names.add(normName(m.name));
  }
  return { jids, names };
}

export function isSenderMapped(senders: MappedSenders, author: string, chatName?: string | null): boolean {
  return senders.jids.has(author) || (!!chatName?.trim() && senders.names.has(normName(chatName)));
}
