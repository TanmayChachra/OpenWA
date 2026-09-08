import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { ClientMapping } from '../client-mapping/entities/client-mapping.entity';
import { Message } from '../message/entities/message.entity';
import { GbrainExportState } from './entities/gbrain-export-state.entity';
import { renderGbrainDocument } from './gbrain-export-render';
import { GbrainCliSink } from './gbrain-sink-cli.service';
import { GbrainWebhookSink } from './gbrain-sink-webhook.service';
import type { GBrainSink } from './gbrain-sink.interface';

/** A batch export is bounded per document so one very chatty chat can't blow up a single GBrain
 * capture into an unbounded payload; the checkpoint still advances to the newest message actually
 * included, so the next run picks up exactly where this one left off rather than skipping any. */
const MAX_MESSAGES_PER_DOCUMENT = 500;

export interface GbrainExportOptions {
  sessionId?: string;
  lookbackDays?: number;
  dryRun?: boolean;
}

export interface GbrainExportDocumentResult {
  entityId: string;
  sessionId: string;
  jid: string;
  name: string;
  messageCount: number;
  delivered: boolean;
  error?: string;
  markdown: string;
}

export interface GbrainExportRunResult {
  dryRun: boolean;
  sink: 'cli' | 'webhook';
  exportedAt: string;
  documentsRendered: number;
  documentsDelivered: number;
  documentsFailed: number;
  documents: GbrainExportDocumentResult[];
}

/** Reads current config into a `GBrainSink` instance. A plain function, not a Nest provider, so
 *  the active sink is decided fresh on every run (config change is a config change, not a restart)
 *  — cheap, since both sink classes are stateless besides the values passed to their constructor. */
export function createGbrainSink(config: {
  sink: 'cli' | 'webhook';
  cliPath: string;
  webhookUrl: string;
  webhookToken?: string;
  webhookTimeoutMs: number;
}): GBrainSink {
  if (config.sink === 'webhook') {
    return new GbrainWebhookSink(config.webhookUrl, config.webhookToken, config.webhookTimeoutMs);
  }
  return new GbrainCliSink(config.cliPath);
}

/**
 * The GBrain scheduled export (docs/32 Phase 2): for every mapped contact/group, renders its
 * Client Mapping row plus the messages since that jid's last successful export (or since
 * `lookbackDays` ago, for a manual backfill / first-ever export) as one markdown document, and
 * hands it to the configured sink. Checkpoints only advance past messages a delivery actually
 * confirmed — `dryRun` never touches them at all, so previewing output is side-effect-free.
 *
 * One document is rendered and (optionally) sent PER MAPPED CONTACT/GROUP, always — including a
 * jid with zero new messages this run. That is deliberate: the front matter always reflects the
 * mapping's CURRENT company/team/role/notes, so a metadata-only edit (someone corrected a client's
 * team in the dashboard) still reaches GBrain on the next scheduled run without a separate
 * change-detection path to get wrong.
 */
@Injectable()
export class GbrainExportService {
  private readonly logger = createLogger('GbrainExportService');

  constructor(
    @InjectRepository(ClientMapping, 'data') private readonly mappings: Repository<ClientMapping>,
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
    @InjectRepository(GbrainExportState, 'data') private readonly state: Repository<GbrainExportState>,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  private config() {
    const get = <T>(key: string, fallback: T): T => this.configService?.get<T>(key, fallback) ?? fallback;
    return {
      sink: get<'cli' | 'webhook'>('gbrainExport.sink', 'cli'),
      cliPath: get<string>('gbrainExport.cliPath', 'gbrain'),
      webhookUrl: get<string>('gbrainExport.webhookUrl', ''),
      webhookToken: get<string | undefined>('gbrainExport.webhookToken', undefined),
      webhookTimeoutMs: get<number>('gbrainExport.webhookTimeoutMs', 10_000),
      defaultLookbackDays: get<number>('gbrainExport.defaultLookbackDays', 1),
    };
  }

  async run(options: GbrainExportOptions = {}, now: Date = new Date()): Promise<GbrainExportRunResult> {
    const cfg = this.config();
    const dryRun = options.dryRun ?? false;
    const sink = createGbrainSink(cfg);

    const mappingRows = await this.mappings.find({
      where: {
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        status: 'active',
      },
    });
    // Groups and teammates are directory entries, not chats with their own message history —
    // a teammate has no sessionId/jid on any WhatsApp chat to pull messages from, and a group's
    // "conversation" is really its members' individual messages, already exported under their own
    // contact rows. Only `contact` rows have a 1:1 chatId this query can pull from.
    const contactMappings = mappingRows.filter(m => m.kind === 'contact' && m.sessionId);

    const documents: GbrainExportDocumentResult[] = [];
    for (const mapping of contactMappings) {
      try {
        documents.push(await this.exportOne(mapping, options, cfg.defaultLookbackDays, sink, dryRun, now));
      } catch (err) {
        // One mapping's query/render failure must not abort the whole batch — every other mapping
        // still gets its export this run, and this one is retried next run (its checkpoint never
        // advanced).
        this.logger.warn('GBrain export failed for one mapping', {
          sessionId: mapping.sessionId ?? undefined,
          jid: mapping.jid,
          error: err instanceof Error ? err.message : String(err),
        });
        documents.push({
          entityId: `${mapping.sessionId}:${mapping.jid}`,
          sessionId: mapping.sessionId as string,
          jid: mapping.jid,
          name: mapping.name,
          messageCount: 0,
          delivered: false,
          error: err instanceof Error ? err.message : String(err),
          markdown: '',
        });
      }
    }

    const result: GbrainExportRunResult = {
      dryRun,
      sink: cfg.sink,
      exportedAt: now.toISOString(),
      documentsRendered: documents.length,
      documentsDelivered: documents.filter(d => d.delivered).length,
      documentsFailed: documents.filter(d => !d.delivered).length,
      documents,
    };
    this.logger.log('GBrain export run complete', {
      dryRun,
      sink: cfg.sink,
      documentsRendered: result.documentsRendered,
      documentsDelivered: result.documentsDelivered,
      documentsFailed: result.documentsFailed,
    });
    return result;
  }

  private async exportOne(
    mapping: ClientMapping,
    options: GbrainExportOptions,
    defaultLookbackDays: number,
    sink: GBrainSink,
    dryRun: boolean,
    now: Date,
  ): Promise<GbrainExportDocumentResult> {
    const sessionId = mapping.sessionId as string;
    const checkpoint = await this.state.findOne({ where: { sessionId, jid: mapping.jid } });

    // Explicit lookbackDays always wins (a manual backfill means "ignore the checkpoint, I want
    // this specific window"). Otherwise: the checkpoint if one exists, or the configured default
    // for a jid that has never been exported before.
    const sinceTimestamp =
      options.lookbackDays !== undefined
        ? now.getTime() - options.lookbackDays * 24 * 60 * 60 * 1000
        : (checkpoint?.lastExportedMessageTimestamp ?? now.getTime() - defaultLookbackDays * 24 * 60 * 60 * 1000);
    // A first-ever export (no checkpoint, no explicit lookbackDays) still has SOME window rather
    // than "since the beginning of time" — defaultLookbackDays bounds that too, so a long-lived
    // account's very first run doesn't try to render its entire history in one document. There is
    // deliberately no "unbounded" case: sinceTimestamp always resolves to one of the three branches
    // above, never null.
    const rows = await this.messages.find({
      where: {
        sessionId,
        chatId: mapping.jid,
        timestamp: MoreThan(sinceTimestamp),
      },
      order: { timestamp: 'ASC' },
      take: MAX_MESSAGES_PER_DOCUMENT,
    });

    const doc = renderGbrainDocument(
      {
        sessionId,
        jid: mapping.jid,
        kind: 'contact',
        name: mapping.name,
        phone: mapping.phone,
        company: mapping.company,
        team: mapping.team,
        role: mapping.role,
        timezone: mapping.timezone,
        notes: mapping.notes,
      },
      rows.map(r => ({
        timestamp: r.timestamp,
        direction: r.direction,
        body: r.body,
        type: r.type,
      })),
      sinceTimestamp,
      now,
    );

    let delivered: boolean;
    let error: string | undefined;
    if (dryRun) {
      delivered = true; // "delivered" reads as "rendering succeeded" in dry-run mode; nothing was sent
    } else {
      const sent = await sink.send(doc);
      delivered = sent.delivered;
      error = sent.error;
      if (delivered && rows.length > 0) {
        const newCheckpoint = rows[rows.length - 1].timestamp;
        await this.state.upsert({ sessionId, jid: mapping.jid, lastExportedMessageTimestamp: newCheckpoint }, [
          'sessionId',
          'jid',
        ]);
      }
    }

    return {
      entityId: doc.entityId,
      sessionId,
      jid: mapping.jid,
      name: mapping.name,
      messageCount: rows.length,
      delivered,
      error,
      markdown: doc.markdown,
    };
  }
}
