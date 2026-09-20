import type { GBrainDocument } from './gbrain-sink.interface';

export interface GbrainExportMappingInput {
  sessionId: string;
  jid: string;
  kind: 'contact' | 'group';
  name: string;
  phone: string | null;
  company: string;
  team: string | null;
  role: string | null;
  timezone: string | null;
  notes: string | null;
}

export interface GbrainExportMessageLine {
  timestamp: number; // epoch-ms
  direction: 'incoming' | 'outgoing';
  body: string | null;
  type: string;
}

/** A single value's worth of YAML front matter, quoted only when it needs to be. */
function yamlScalar(value: string): string {
  // A plain scalar is only unsafe when it starts with a character YAML would otherwise parse as
  // structure, or contains a colon-space/hash that would truncate the value — quoting always, for
  // every field, would just make the front matter noisier to read for the common case (names,
  // company names) that never hits this.
  if (/^[\s#>|*&!%@`"'-]|:\s|:$/.test(value) || value === '') {
    return JSON.stringify(value);
  }
  return value;
}

function yamlLine(key: string, value: string | number | null): string {
  if (value === null) return `${key}: null`;
  return `${key}: ${typeof value === 'number' ? value : yamlScalar(value)}`;
}

/**
 * Renders one `ClientMapping` row plus its message delta as a single GBrain document (docs/32 §Phase
 * 2): YAML front matter carrying the structured fields GBrain's entity layer keys on (`company`,
 * `team`, `role`, `kind` — Phase 1's own fields, unchanged), and a markdown body a human — or
 * GBrain's `synthesize` verb — can read directly. `entityId` is `${sessionId}:${jid}`, stable across
 * re-exports of the same contact/group so GBrain updates one entity rather than minting a new one
 * per run.
 *
 * Pure and synchronous on purpose: every value it needs is passed in, so rendering is unit-testable
 * without a database, and the exact same function backs both the real scheduled export and a
 * `dryRun` manual trigger that never touches a sink.
 */
export function renderGbrainDocument(
  mapping: GbrainExportMappingInput,
  messages: GbrainExportMessageLine[],
  sinceTimestamp: number | null,
  exportedAt: Date,
): GBrainDocument {
  const entityId = `${mapping.sessionId}:${mapping.jid}`;
  const frontMatter = [
    yamlLine('entityId', entityId),
    yamlLine('kind', mapping.kind),
    yamlLine('name', mapping.name),
    yamlLine('company', mapping.company),
    yamlLine('team', mapping.team),
    yamlLine('role', mapping.role),
    yamlLine('phone', mapping.phone),
    yamlLine('timezone', mapping.timezone),
    yamlLine('sessionId', mapping.sessionId),
    yamlLine('jid', mapping.jid),
    yamlLine('exportedAt', exportedAt.toISOString()),
    yamlLine('sinceTimestamp', sinceTimestamp === null ? null : new Date(sinceTimestamp).toISOString()),
    yamlLine('messageCount', messages.length),
  ].join('\n');

  const heading = `# ${mapping.name}${mapping.company !== 'Unknown' ? ` (${mapping.company})` : ''}`;

  const metaLines = [
    `- **Kind:** ${mapping.kind}`,
    `- **Company:** ${mapping.company}`,
    mapping.team ? `- **Team:** ${mapping.team}` : null,
    mapping.role ? `- **Role:** ${mapping.role}` : null,
    mapping.phone ? `- **Phone:** ${mapping.phone}` : null,
    mapping.timezone ? `- **Timezone:** ${mapping.timezone}` : null,
  ].filter((line): line is string => line !== null);

  const notesSection = mapping.notes ? `\n## Notes\n\n${mapping.notes}\n` : '';

  const messageLines =
    messages.length === 0
      ? '_No new messages in this window._'
      : messages
          .map(m => {
            const stamp = new Date(m.timestamp).toISOString();
            const text = m.body?.trim() ? m.body.trim() : `(${m.type})`;
            return `- [${stamp}] (${m.direction}) ${text}`;
          })
          .join('\n');

  const windowLabel =
    sinceTimestamp === null ? 'all available history' : `since ${new Date(sinceTimestamp).toISOString()}`;

  const markdown = `---\n${frontMatter}\n---\n\n${heading}\n\n${metaLines.join('\n')}\n${notesSection}\n## Messages (${windowLabel})\n\n${messageLines}\n`;

  return { entityId, markdown };
}
