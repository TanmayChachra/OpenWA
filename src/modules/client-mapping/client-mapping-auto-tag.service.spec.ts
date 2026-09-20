// Auto-tag fires on every inbound message, so it must be correct on both branches (contact/group),
// dedupe against a row that already exists, and never let a DB failure escape into the receive
// path — the same contract automation-rules' evaluateInbound already carries.
import { DataSource } from 'typeorm';
import { HookManager } from '../../core/hooks/hook-manager.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { ClientMappingAutoTagService } from './client-mapping-auto-tag.service';
import { ClientMappingService } from './client-mapping.service';
import { ClientMappingIdentityService } from './client-mapping-identity.service';
import { ClientMapping } from './entities/client-mapping.entity';
import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';

describe('ClientMappingAutoTagService', () => {
  let ds: DataSource;
  let service: ClientMappingAutoTagService;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ClientMapping],
      synchronize: true,
    });
    await ds.initialize();
    // Real EngineRegistry with nothing registered, same as client-mapping.service.spec.ts — every
    // resolvePhone call in these tests answers straight off the jid (a real @c.us) or null (a @lid
    // this "engine" can't map), with no network/mock involved.
    const mappings = new ClientMappingService(
      ds.getRepository(ClientMapping),
      new ClientMappingIdentityService(new EngineRegistry()),
    );
    service = new ClientMappingAutoTagService(mappings);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const inbound = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id: 'wamid.1',
    from: '628111@c.us',
    to: '919211281181@c.us',
    chatId: '628111@c.us',
    body: 'hi',
    type: 'text',
    timestamp: 1_700_000_000,
    fromMe: false,
    isGroup: false,
    kind: 'individual',
    ...over,
  });

  it('creates a contact mapping on the first message from a new number', async () => {
    await service.evaluateInbound('s1', inbound({ contact: { pushName: 'Alice' } }));

    const rows = await ds.getRepository(ClientMapping).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: 's1',
      jid: '628111@c.us',
      kind: 'contact',
      name: 'Alice',
      phone: '628111',
      company: 'Unknown',
    });
  });

  it('creates a group mapping, with the raw id as a name fallback (no group-name field on a message)', async () => {
    await service.evaluateInbound(
      's1',
      inbound({
        chatId: '120363000@g.us',
        from: '120363000@g.us',
        isGroup: true,
        kind: 'group',
        author: '628111@c.us',
      }),
    );

    const rows = await ds.getRepository(ClientMapping).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'group', jid: '120363000@g.us', name: '120363000', phone: null });
  });

  it('does not create a phone for a group, or for a @lid contact it cannot resolve locally', async () => {
    await service.evaluateInbound('s1', inbound({ chatId: '99999@lid', from: '99999@lid', isLidSender: true }));

    const rows = await ds.getRepository(ClientMapping).find();
    expect(rows[0].phone).toBeNull();
  });

  it('is a no-op for an outgoing (fromMe) message — never tags your own account', async () => {
    await service.evaluateInbound('s1', inbound({ fromMe: true }));
    expect(await ds.getRepository(ClientMapping).find()).toHaveLength(0);
  });

  it('does not duplicate a mapping that already exists for this (sessionId, jid, kind)', async () => {
    await service.evaluateInbound('s1', inbound());
    await service.evaluateInbound('s1', inbound({ body: 'second message' }));

    expect(await ds.getRepository(ClientMapping).find()).toHaveLength(1);
  });

  it('scopes by session: the same jid in a different session gets its own row', async () => {
    await service.evaluateInbound('s1', inbound());
    await service.evaluateInbound('s2', inbound());

    const rows = await ds.getRepository(ClientMapping).find();
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('is disabled when clientMapping.autoTagEnabled is false, without throwing', async () => {
    const disabled = new ClientMappingAutoTagService(
      new ClientMappingService(ds.getRepository(ClientMapping), new ClientMappingIdentityService(new EngineRegistry())),
      { get: () => false } as never,
    );

    await disabled.evaluateInbound('s1', inbound());

    expect(await ds.getRepository(ClientMapping).find()).toHaveLength(0);
  });

  it('swallows a repository failure instead of rejecting (fire-and-forget contract)', async () => {
    const brokenMappings = new ClientMappingService(
      { findOne: () => Promise.reject(new Error('db down')) } as never,
      new ClientMappingIdentityService(new EngineRegistry()),
    );
    const broken = new ClientMappingAutoTagService(brokenMappings);

    await expect(broken.evaluateInbound('s1', inbound())).resolves.toBeUndefined();
  });

  // Core no longer calls this service; it rides the `message:persisted` hook. These run the real
  // HookManager end to end so a change to the hook payload shape fails here, not silently in prod.
  describe('via the message:persisted hook', () => {
    let hooks: HookManager;
    let upsert: jest.SpyInstance;

    beforeEach(() => {
      hooks = new HookManager();
      const mappings = new ClientMappingService(
        ds.getRepository(ClientMapping),
        new ClientMappingIdentityService(new EngineRegistry()),
      );
      upsert = jest.spyOn(mappings, 'resolveAndUpsert');
      service = new ClientMappingAutoTagService(mappings, undefined, hooks);
      service.onModuleInit();
    });

    const persisted = (message: Record<string, unknown>) =>
      hooks.execute('message:persisted', { sessionId: 's1', message }, { sessionId: 's1', source: 'test' });

    it('tags an inbound 1:1 chat, using the chat name as the name hint', async () => {
      await persisted({ direction: 'incoming', chatId: '628111@c.us', chatName: 'Alice' });
      expect(upsert).toHaveBeenCalledWith({ sessionId: 's1', jid: '628111@c.us', kind: 'contact', nameHint: 'Alice' });
      expect(await ds.getRepository(ClientMapping).count()).toBe(1);
    });

    it('tags an inbound group without borrowing the sender name as the group name', async () => {
      await persisted({ direction: 'incoming', chatId: '120363@g.us', chatName: 'Some Sender' });
      expect(upsert).toHaveBeenCalledWith({ sessionId: 's1', jid: '120363@g.us', kind: 'group', nameHint: undefined });
    });

    it('ignores a phone-composed send (outgoing rows also fire message:persisted)', async () => {
      await persisted({ direction: 'outgoing', chatId: '628111@c.us', chatName: 'Alice' });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('never fails the hook chain when tagging throws', async () => {
      upsert.mockRejectedValueOnce(new Error('db down'));
      const result = await persisted({ direction: 'incoming', chatId: '628111@c.us' });
      expect(result.continue).toBe(true);
    });

    it('stops listening once destroyed', async () => {
      service.onModuleDestroy();
      await persisted({ direction: 'incoming', chatId: '628111@c.us' });
      expect(upsert).not.toHaveBeenCalled();
    });
  });
});
