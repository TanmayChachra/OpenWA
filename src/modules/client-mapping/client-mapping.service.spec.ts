import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ClientMappingService } from './client-mapping.service';
import { ClientMapping } from './entities/client-mapping.entity';

describe('ClientMappingService', () => {
  let ds: DataSource;
  let service: ClientMappingService;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ClientMapping],
      synchronize: true,
    });
    await ds.initialize();
    service = new ClientMappingService(ds.getRepository(ClientMapping));
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const contactDto = (over: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    jid: '628111@c.us',
    kind: 'contact' as const,
    name: 'Alice',
    company: 'Acme',
    ...over,
  });

  describe('create', () => {
    it('creates a contact mapping with defaults applied', async () => {
      const mapping = await service.create(contactDto());
      expect(mapping.id).toBeDefined();
      expect(mapping.status).toBe('active');
      expect(mapping.sentimentTracking).toBe(true);
      expect(mapping.phone).toBeNull();
    });

    it('rejects a contact/group mapping with no sessionId', async () => {
      await expect(service.create(contactDto({ sessionId: undefined }))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a teammate mapping that sets sessionId', async () => {
      await expect(
        service.create({
          sessionId: 's1',
          jid: 'alice@unbundl.com',
          kind: 'teammate',
          name: 'Alice',
          company: 'Unbundl',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows a teammate mapping with no sessionId', async () => {
      const mapping = await service.create({
        jid: 'alice@unbundl.com',
        kind: 'teammate',
        name: 'Alice',
        company: 'Unbundl',
        team: 'Performance',
      });
      expect(mapping.sessionId).toBeNull();
      expect(mapping.team).toBe('Performance');
    });

    it('rejects a duplicate (sessionId, jid, kind) via the DB unique index', async () => {
      await service.create(contactDto());
      await expect(service.create(contactDto({ name: 'Alice again' }))).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows the same jid across two different sessions', async () => {
      await service.create(contactDto());
      await expect(service.create(contactDto({ sessionId: 's2' }))).resolves.toBeDefined();
    });

    it('rejects a duplicate teammate jid via the application-level check', async () => {
      await service.create({ jid: 'alice@unbundl.com', kind: 'teammate', name: 'Alice', company: 'Unbundl' });
      await expect(
        service.create({ jid: 'alice@unbundl.com', kind: 'teammate', name: 'Alice dup', company: 'Unbundl' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an unknown backupOwnerId', async () => {
      await expect(
        service.create(contactDto({ backupOwnerId: '00000000-0000-0000-0000-000000000000' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a backupOwnerId pointing at an existing mapping', async () => {
      const owner = await service.create(contactDto({ jid: '628222@c.us' }));
      const mapping = await service.create(contactDto({ backupOwnerId: owner.id }));
      expect(mapping.backupOwnerId).toBe(owner.id);
    });
  });

  describe('update', () => {
    it('applies only the provided fields', async () => {
      const mapping = await service.create(contactDto());
      const updated = await service.update(mapping.id, { team: 'Design' });
      expect(updated.team).toBe('Design');
      expect(updated.name).toBe('Alice');
    });

    it('rejects backupOwnerId referencing itself', async () => {
      const mapping = await service.create(contactDto());
      await expect(service.update(mapping.id, { backupOwnerId: mapping.id })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws NotFoundException for an unknown id', async () => {
      await expect(service.update('00000000-0000-0000-0000-000000000000', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    it('filters by kind and company', async () => {
      await service.create(contactDto());
      await service.create({ jid: 'alice@unbundl.com', kind: 'teammate', name: 'Alice', company: 'Unbundl' });

      const contacts = await service.findAll({ kind: 'contact' });
      expect(contacts).toHaveLength(1);
      expect(contacts[0].kind).toBe('contact');

      const unbundl = await service.findAll({ company: 'Unbundl' });
      expect(unbundl).toHaveLength(1);
      expect(unbundl[0].kind).toBe('teammate');
    });

    // The route this backs is @RequireUnscopedKey-gated, so allowedSessions is always null/empty in
    // practice — but resolveSessionScope is threaded through anyway (see the method's doc comment),
    // and that wiring is worth pinning on its own so it stays correct if the gate is ever loosened.
    it('restricts to allowedSessions when the calling key is session-scoped', async () => {
      await service.create(contactDto({ sessionId: 's1' }));
      await service.create(contactDto({ sessionId: 's2', jid: '628333@c.us' }));

      const scoped = await service.findAll({}, ['s1']);
      expect(scoped.map(m => m.sessionId)).toEqual(['s1']);
    });

    it('returns empty when the requested sessionId is outside allowedSessions', async () => {
      await service.create(contactDto({ sessionId: 's2' }));

      const scoped = await service.findAll({ sessionId: 's2' }, ['s1']);
      expect(scoped).toEqual([]);
    });
  });

  describe('remove', () => {
    it('deletes the mapping', async () => {
      const mapping = await service.create(contactDto());
      await service.remove(mapping.id);
      await expect(service.findOne(mapping.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
