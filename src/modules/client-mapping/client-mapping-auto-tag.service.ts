import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { parseWaId, userPart } from '../../engine/identity/wa-id';
import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { ClientMapping, ClientMappingKind } from './entities/client-mapping.entity';

/**
 * Placeholder written for company — the one field this fast, synchronous path can never resolve
 * (WhatsApp has no concept of "which client this chat belongs to"). Identical to the one "Import
 * from Chats" writes, so both paths flag a row incomplete via the exact same signal (see
 * ClientMappings.tsx isIncompleteMapping) regardless of which one created it.
 */
const UNKNOWN_COMPANY = 'Unknown';

/**
 * Auto-seeds a Client Mapping row (docs/32) the first time a session sees a chat, contact or
 * group alike, instead of requiring "Import from Chats" to be run by hand. Fired fire-and-forget
 * from the same inbound dispatch stage as automation rules (see message-projector.service.ts) —
 * same contract: a failure here must never surface into the receive path.
 *
 * Deliberately stays off the network: only fields already on the message payload are used (no
 * engine round trip), so this never adds latency to the hot inbound path. That means a brand-new
 * GROUP's name is not resolvable here (WhatsApp does not carry a group's subject on the message
 * itself, only on its own chat-list entry) and falls back to the raw id — the same fallback
 * "Import from Chats" uses for an unresolved chat.name, so both paths flag it incomplete the same
 * way rather than one silently guessing better than the other.
 */
@Injectable()
export class ClientMappingAutoTagService {
  private readonly logger = createLogger('ClientMappingAutoTagService');

  constructor(
    @InjectRepository(ClientMapping, 'data') private readonly repo: Repository<ClientMapping>,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  async evaluateInbound(sessionId: string, message: IncomingMessage): Promise<void> {
    if (message.fromMe) return;
    if (!(this.configService?.get<boolean>('clientMapping.autoTagEnabled', true) ?? true)) return;

    const jid = message.chatId;
    const kind: ClientMappingKind = message.isGroup ? 'group' : 'contact';

    try {
      const existing = await this.repo.findOne({ where: { sessionId, jid, kind } });
      if (existing) return;

      // A group JID's "user part" is its own id, never a phone — only a 1:1 chat backed by a real
      // (non-@lid) address resolves to one without a network call.
      const parsed = parseWaId(jid);
      const phone = !message.isGroup && parsed.kind === 'user' ? parsed.userPart : null;
      const resolvedName = message.isGroup ? undefined : (message.contact?.pushName ?? message.contact?.name);

      const name = resolvedName || userPart(jid);
      await this.repo.save(
        this.repo.create({
          sessionId,
          jid,
          kind,
          name,
          phone,
          company: UNKNOWN_COMPANY,
          team: null,
          role: null,
          timezone: null,
          status: 'active',
          backupOwnerId: null,
          sentimentTracking: true,
          notes: null,
        }),
      );
      // The one positive signal this path ever emits — without it, a created row is
      // indistinguishable from one added by hand or by "Import from Chats" (see #incident: two
      // manually-created rows were mistaken for auto-tag output purely from their timestamps).
      this.logger.log('Auto-tagged new client mapping', { sessionId, jid, kind, name });
    } catch (error) {
      // A unique-violation here is the benign race of two inbound messages for the same brand-new
      // chat landing concurrently (the (sessionId, jid, kind) index rejects the second insert) —
      // one row ends up existing either way, which is all this path promises, so it doesn't warrant
      // a warning. Anything else is a genuine failure.
      if (isUniqueViolation(error)) return;
      this.logger.warn('Client mapping auto-tag failed', {
        sessionId,
        jid,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
