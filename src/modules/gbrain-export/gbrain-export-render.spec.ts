import { renderGbrainDocument } from './gbrain-export-render';

const baseMapping = {
  sessionId: 's1',
  jid: '628111@c.us',
  kind: 'contact' as const,
  name: 'Alice',
  phone: '628111',
  company: 'Acme',
  team: 'Sales',
  role: 'Account Manager',
  timezone: 'Asia/Jakarta',
  notes: null,
};

describe('renderGbrainDocument', () => {
  it('entityId is sessionId:jid, stable across re-renders of the same mapping', () => {
    const doc = renderGbrainDocument(baseMapping, [], null, new Date('2026-01-01T00:00:00.000Z'));
    expect(doc.entityId).toBe('s1:628111@c.us');
  });

  it('front matter carries company/team/role/kind — the fields GBrain keys its entity layer on', () => {
    const doc = renderGbrainDocument(baseMapping, [], null, new Date('2026-01-01T00:00:00.000Z'));
    expect(doc.markdown).toContain('kind: contact');
    expect(doc.markdown).toContain('company: Acme');
    expect(doc.markdown).toContain('team: Sales');
    expect(doc.markdown).toContain('role: Account Manager');
  });

  it('a null field renders as YAML null, not the literal string "null"', () => {
    const doc = renderGbrainDocument({ ...baseMapping, team: null, role: null }, [], null, new Date());
    expect(doc.markdown).toContain('team: null');
    expect(doc.markdown).toContain('role: null');
  });

  it('quotes a value that would otherwise be misread as YAML structure', () => {
    const doc = renderGbrainDocument({ ...baseMapping, company: '#1 Client: Acme' }, [], null, new Date());
    expect(doc.markdown).toContain('company: "#1 Client: Acme"');
  });

  it('messages render oldest first, one bullet each, with direction and ISO timestamp', () => {
    const doc = renderGbrainDocument(
      baseMapping,
      [
        { timestamp: 1700000000000, direction: 'incoming', body: 'hi', type: 'text' },
        { timestamp: 1700000001000, direction: 'outgoing', body: 'hello back', type: 'text' },
      ],
      null,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    const hiLine = doc.markdown.split('\n').find(l => l.startsWith('- [') && l.includes(') hi'));
    expect(hiLine).toContain('(incoming)');
    expect(hiLine).toContain(new Date(1700000000000).toISOString());
    expect(doc.markdown.indexOf('hi')).toBeLessThan(doc.markdown.indexOf('hello back'));
  });

  it('a message with no body (media) falls back to "(type)" instead of an empty bullet', () => {
    const doc = renderGbrainDocument(
      baseMapping,
      [{ timestamp: 1700000000000, direction: 'incoming', body: null, type: 'image' }],
      null,
      new Date(),
    );
    expect(doc.markdown).toContain('(image)');
  });

  it('zero messages renders an explicit "no new messages" line, not an empty section', () => {
    const doc = renderGbrainDocument(baseMapping, [], 1700000000000, new Date());
    expect(doc.markdown).toContain('No new messages in this window');
  });

  it('includes a Notes section only when notes is set', () => {
    const withNotes = renderGbrainDocument({ ...baseMapping, notes: 'Prefers evenings.' }, [], null, new Date());
    expect(withNotes.markdown).toContain('## Notes');
    expect(withNotes.markdown).toContain('Prefers evenings.');

    const withoutNotes = renderGbrainDocument(baseMapping, [], null, new Date());
    expect(withoutNotes.markdown).not.toContain('## Notes');
  });

  it('an Unknown company is not parenthesized onto the heading (nothing useful to show)', () => {
    const doc = renderGbrainDocument({ ...baseMapping, company: 'Unknown' }, [], null, new Date());
    expect(doc.markdown).toMatch(/^---[\s\S]*?\n# Alice\n/);
  });

  it('a real company IS parenthesized onto the heading', () => {
    const doc = renderGbrainDocument(baseMapping, [], null, new Date());
    expect(doc.markdown).toContain('# Alice (Acme)');
  });
});
