import { ClientMappingIdentityService } from './client-mapping-identity.service';

describe('ClientMappingIdentityService.resolvePhone', () => {
  const lidJid = '166868170059932@lid';
  const build = (engine: unknown) => {
    const remember = jest.fn().mockResolvedValue(undefined);
    const svc = new ClientMappingIdentityService(
      { get: jest.fn().mockReturnValue(engine) } as never,
      { getCached: jest.fn().mockReturnValue(undefined), remember } as never,
    );
    return { svc, remember };
  };

  it('resolves a @c.us jid without touching the engine', async () => {
    const { svc, remember } = build(undefined);
    expect(await svc.resolvePhone('s1', '628111@c.us')).toBe('628111');
    expect(remember).not.toHaveBeenCalled();
  });

  it('persists a definitive engine answer, including a definitive null', async () => {
    const { svc, remember } = build({ resolveContactPhone: jest.fn().mockResolvedValue(null) });
    expect(await svc.resolvePhone('s1', lidJid)).toBeNull();
    expect(remember).toHaveBeenCalledWith('166868170059932', null, 's1');
  });

  it('does not persist when the engine is missing (transient miss must not overwrite a stored mapping)', async () => {
    const { svc, remember } = build(undefined);
    expect(await svc.resolvePhone('s1', lidJid)).toBeNull();
    expect(remember).not.toHaveBeenCalled();
  });

  it('does not persist when the engine throws', async () => {
    const { svc, remember } = build({ resolveContactPhone: jest.fn().mockRejectedValue(new Error('boom')) });
    expect(await svc.resolvePhone('s1', lidJid)).toBeNull();
    expect(remember).not.toHaveBeenCalled();
  });
});
