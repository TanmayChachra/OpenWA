import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../../core/hooks/hook-manager.service';
import type { HookContext, HookResult } from '../../core/hooks/hook.interfaces';
import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { chatKind } from '../../engine/identity/wa-id';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { ClientMappingKind } from './entities/client-mapping.entity';
import { ClientMappingService } from './client-mapping.service';

/** Owner id the hook registration is filed under (and unregistered by). */
const HOOK_PLUGIN_ID = 'unbundl-client-mapping';

/**
 * Auto-seeds a Client Mapping row (docs/32) the first time a session sees a chat, contact or
 * group alike, instead of requiring "Import from Chats" to be run by hand. Fired fire-and-forget
 * from the same inbound dispatch stage as automation rules (see message-projector.service.ts) —
 * same contract: a failure here must never surface into the receive path.
 *
 * Identity resolution and the "does this already exist" decision live in
 * {@link ClientMappingService.resolveAndUpsert} (docs/33 Phase B), shared with "Import from Chats"
 * — this service's only job is turning an inbound message into that one call's inputs.
 */
@Injectable()
export class ClientMappingAutoTagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('ClientMappingAutoTagService');

  constructor(
    private readonly mappings: ClientMappingService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly hookManager?: HookManager,
  ) {}

  /**
   * Subscribes to the core `message:persisted` hook rather than being called from the session
   * module: core stays unaware this module exists, so an upstream sync cannot conflict on it. The
   * hook fires only after the insert's dedupe oracle accepted a new row, the same at-most-once
   * guarantee the old direct call rode; the one difference is that a message whose insert failed
   * transiently is not tagged (it is on the next message from that chat). Fail-open: a handler
   * never throws into the receive path.
   */
  onModuleInit(): void {
    this.hookManager?.register(HOOK_PLUGIN_ID, 'message:persisted', ctx => this.onPersisted(ctx));
  }

  onModuleDestroy(): void {
    this.hookManager?.unregisterPlugin(HOOK_PLUGIN_ID);
  }

  private async onPersisted(ctx: HookContext<unknown>): Promise<HookResult<unknown>> {
    const { sessionId, message } = ctx.data as { sessionId?: string; message?: Message };
    // `message:persisted` also fires for phone-composed sends; only inbound traffic auto-tags.
    if (sessionId && message?.direction === MessageDirection.INCOMING) {
      await this.evaluateInbound(sessionId, {
        chatId: message.chatId,
        fromMe: false,
        isGroup: chatKind(message.chatId) === 'group',
        contact: message.chatName ? { pushName: message.chatName } : undefined,
      } as IncomingMessage).catch(() => undefined);
    }
    return { continue: true };
  }

  async evaluateInbound(sessionId: string, message: IncomingMessage): Promise<void> {
    if (message.fromMe) return;
    if (!(this.configService?.get<boolean>('clientMapping.autoTagEnabled', true) ?? true)) return;

    const jid = message.chatId;
    const kind: ClientMappingKind = message.isGroup ? 'group' : 'contact';
    // A brand-new GROUP's name is not resolvable here (WhatsApp does not carry a group's subject on
    // the message itself, only on its own chat-list entry) — resolveAndUpsert's raw-id fallback
    // covers that, the same fallback "Import from Chats" uses for an unresolved chat.name.
    const nameHint = message.isGroup ? undefined : (message.contact?.pushName ?? message.contact?.name);

    try {
      const { mapping, created } = await this.mappings.resolveAndUpsert({ sessionId, jid, kind, nameHint });
      if (created) {
        // The one positive signal this path ever emits — without it, a created row is
        // indistinguishable from one added by hand or by "Import from Chats" (see #incident: two
        // manually-created rows were mistaken for auto-tag output purely from their timestamps).
        this.logger.log('Auto-tagged new client mapping', {
          sessionId,
          jid: mapping.jid,
          kind,
          name: mapping.name,
        });
      }
    } catch (error) {
      this.logger.warn('Client mapping auto-tag failed', {
        sessionId,
        jid,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
