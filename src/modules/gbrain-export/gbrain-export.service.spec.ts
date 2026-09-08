import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ClientMapping } from '../client-mapping/entities/client-mapping.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { GbrainExportState } from './entities/gbrain-export-state.entity';
import { GbrainExportService } from './gbrain-export.service';

// Routes the service at the real webhook sink (not the default cli sink), then fakes `fetch` under
// it — this exercises the full run()/exportOne() flow through its real config-reading path without
// spawning a process or hitting the network, and lets tests inspect exactly what was "sent".
const fakeConfig = (overrides: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    'gbrainExport.sink': 'webhook',
    'gbrainExport.cliPath': 'gbrain',
    'gbrainExport.webhookUrl': 'https://fake.example/ingest',
    'gbrainExport.webhookToken': undefined,
    'gbrainExport.webhookTimeoutMs': 5000,
    'gbrainExport.defaultLookbackDays': 1,
    ...overrides,
  };
  return {
    get: (key: string, fallback: unknown) => (key in values ? values[key] : fallback),
  } as unknown as ConfigService;
};

describe('GbrainExportService', () => {
  let ds: DataSource;
  let mappings: Repository<ClientMapping>;
  let messages: Repository<Message>;
  let state: Repository<GbrainExportState>;
  let service: GbrainExportService;
  let fetchMock: jest.MockedFunction<typeof fetch>;
  let originalFetch: typeof fetch;
  let seq: number;

  beforeEach(async () => {
    seq = 0;
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ClientMapping, Message, GbrainExportState],
      synchronize: true,
    });
    await ds.initialize();
    mappings = ds.getRepository(ClientMapping);
    messages = ds.getRepository(Message);
    state = ds.getRepository(GbrainExportState);
    service = new GbrainExportService(mappings, messages, state, fakeConfig());

    originalFetch = global.fetch;
    fetchMock = jest.fn();
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' } as unknown as Response);
    global.fetch = fetchMock;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await ds.destroy();
  });

  const sentBodies = () => fetchMock.mock.calls.map(([, init]) => init?.body as string);

  const seedMapping = async (over: Partial<ClientMapping> = {}): Promise<ClientMapping> =>
    mappings.save(
      mappings.create({
        sessionId: 's1',
        jid: '628111@c.us',
        kind: 'contact',
        name: 'Alice',
        phone: '628111',
        company: 'Acme',
        team: null,
        role: null,
        timezone: null,
        status: 'active',
        backupOwnerId: null,
        sentimentTracking: true,
        notes: null,
        aliasJids: null,
        ...over,
      }),
    );

  const seedMessage = async (over: Partial<Message> = {}): Promise<Message> => {
    const n = ++seq;
    return messages.save(
      messages.create({
        sessionId: 's1',
        chatId: '628111@c.us',
        from: '628111@c.us',
        to: 'me',
        body: `hello ${n}`,
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: Date.now(),
        ...over,
      }),
    );
  };

  it('skips group and teammate mappings — only contact rows have a chat to pull messages from', async () => {
    await seedMapping({ kind: 'group', jid: 'group1@g.us' });
    await seedMapping({ kind: 'teammate', sessionId: null, jid: 'alice@internal' });

    const result = await service.run({});

    expect(result.documentsRendered).toBe(0);
  });

  it('renders every active contact mapping in dry-run without ever calling the sink', async () => {
    await seedMapping();
    await seedMessage({ timestamp: Date.now() - 1000 });

    const dry = await service.run({ dryRun: true });

    expect(dry.documentsRendered).toBe(1);
    expect(dry.documentsDelivered).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a real run delivers via the configured sink and the document carries the mapping name/company', async () => {
    await seedMapping();
    await seedMessage({ timestamp: Date.now() - 1000 });

    const real = await service.run({ dryRun: false });

    expect(real.documentsDelivered).toBe(1);
    expect(sentBodies()).toHaveLength(1);
    expect(sentBodies()[0]).toContain('# Alice (Acme)');
  });

  it('excludes an inactive mapping from the run', async () => {
    await seedMapping({ status: 'inactive' });

    const result = await service.run({});

    expect(result.documentsRendered).toBe(0);
  });

  it('a dry run never writes a checkpoint, so the next real run still sees the full window', async () => {
    await seedMapping();
    const msg = await seedMessage({ timestamp: Date.now() - 1000 });

    await service.run({ dryRun: true });
    expect(await state.findOne({ where: { sessionId: 's1', jid: '628111@c.us' } })).toBeNull();

    await service.run({ dryRun: false });
    const checkpoint = await state.findOne({ where: { sessionId: 's1', jid: '628111@c.us' } });
    expect(checkpoint?.lastExportedMessageTimestamp).toBe(msg.timestamp);
  });

  it('a second real run only includes messages after the checkpoint left by the first', async () => {
    await seedMapping();
    await seedMessage({ timestamp: Date.now() - 5000, body: 'first-message-marker' });

    const firstRun = await service.run({ dryRun: false });
    expect(firstRun.documents[0].messageCount).toBe(1);

    await seedMessage({ timestamp: Date.now() - 1000, body: 'second-message-marker' });
    const secondRun = await service.run({ dryRun: false });

    expect(secondRun.documents[0].messageCount).toBe(1);
    expect(sentBodies()[1]).toContain('second-message-marker');
    expect(sentBodies()[1]).not.toContain('first-message-marker');
  });

  it('an explicit lookbackDays overrides an existing checkpoint (manual backfill)', async () => {
    await seedMapping();
    await seedMessage({ timestamp: Date.now() - 5000, body: 'old-message-marker' });
    await service.run({ dryRun: false }); // establishes a checkpoint past the old message

    const backfill = await service.run({ dryRun: false, lookbackDays: 30 });

    expect(backfill.documents[0].messageCount).toBe(1);
    expect(sentBodies()[sentBodies().length - 1]).toContain('old-message-marker');
  });

  it('a failed delivery leaves the checkpoint untouched, so the same window is retried next run', async () => {
    await seedMapping();
    await seedMessage({ timestamp: Date.now() - 1000 });
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' } as unknown as Response);

    const result = await service.run({ dryRun: false });

    expect(result.documentsFailed).toBe(1);
    expect(await state.findOne({ where: { sessionId: 's1', jid: '628111@c.us' } })).toBeNull();
  });

  it('caps a single document at MAX_MESSAGES_PER_DOCUMENT and advances the checkpoint only to the newest included message', async () => {
    await seedMapping();
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 510; i++) {
      await seedMessage({ timestamp: base + i, body: `m${i}` });
    }

    const result = await service.run({ dryRun: false });

    expect(result.documents[0].messageCount).toBe(500);
    const checkpoint = await state.findOne({ where: { sessionId: 's1', jid: '628111@c.us' } });
    expect(checkpoint?.lastExportedMessageTimestamp).toBe(base + 499);
  });

  it('one mapping throwing does not stop the rest of the batch from being exported', async () => {
    await seedMapping({ jid: 'bad@c.us', phone: '111' });
    await seedMapping({ jid: 'good@c.us', phone: '222' });
    const findSpy = jest.spyOn(messages, 'find').mockImplementationOnce(() => {
      throw new Error('query blew up');
    });

    const result = await service.run({ dryRun: true });

    expect(result.documentsRendered).toBe(2);
    expect(result.documentsFailed).toBe(1);
    expect(result.documents.find(d => d.jid === 'bad@c.us')?.error).toContain('query blew up');
    expect(result.documents.find(d => d.jid === 'good@c.us')?.delivered).toBe(true);
    findSpy.mockRestore();
  });

  it('filters to a single sessionId when one is requested', async () => {
    await seedMapping({ sessionId: 's1', jid: 'a@c.us' });
    await seedMapping({ sessionId: 's2', jid: 'b@c.us' });

    const result = await service.run({ sessionId: 's1' });

    expect(result.documentsRendered).toBe(1);
    expect(result.documents[0].jid).toBe('a@c.us');
  });
});
