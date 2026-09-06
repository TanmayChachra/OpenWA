import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, Download, Loader2, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import { contactApi, groupApi, sessionApi } from '../services/api';
import type { ClientMapping, ClientMappingKind, ClientMappingPayload, ClientMappingStatus } from '../services/api';
import { CLIENT_MAPPING_KINDS, CLIENT_MAPPING_STATUSES } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import {
  useClientMappingsQuery,
  useCreateClientMappingMutation,
  useDeleteClientMappingMutation,
  useSessionsQuery,
  useUpdateClientMappingMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { groupedTimezones } from '../utils/timezones';
import { parsePhoneFromJid } from '../utils/formatPhone';
import './ClientMappings.css';

/** Placeholder written by "Import from Chats" for the one field it cannot know: which client a
 * WhatsApp chat belongs to. Also what flags a row incomplete in the table (see isIncompleteMapping). */
const UNKNOWN_COMPANY = 'Unknown';

/** A row that still needs a human pass: either the import left the company as a placeholder, or
 * WhatsApp gave no resolvable name for the chat (pushName/contact name), so the raw id was used. */
function isIncompleteMapping(mapping: ClientMapping): boolean {
  if (mapping.kind === 'teammate') return false;
  return mapping.company === UNKNOWN_COMPANY || mapping.name === mapping.jid.split('@')[0];
}

interface MappingForm {
  sessionId: string;
  jid: string;
  kind: ClientMappingKind;
  name: string;
  phone: string;
  company: string;
  team: string;
  role: string;
  timezone: string;
  status: ClientMappingStatus;
  backupOwnerId: string;
  sentimentTracking: boolean;
  notes: string;
}

const emptyForm: MappingForm = {
  sessionId: '',
  jid: '',
  kind: 'contact',
  name: '',
  phone: '',
  company: '',
  team: '',
  role: '',
  // Most of this team's clients/teammates are IST, so default a new mapping there instead of
  // making every create pick it explicitly. formFromMapping (editing an existing row) overrides
  // this with whatever is actually stored, including "not set" — the default only applies to new rows.
  timezone: 'Asia/Kolkata',
  status: 'active',
  backupOwnerId: '',
  sentimentTracking: true,
  notes: '',
};

/** Carried via router state by the Chats page's "Tag as Client" button — see Chats.tsx. */
export interface ClientMappingPrefill {
  sessionId: string;
  jid: string;
  kind: ClientMappingKind;
  name?: string;
  phone?: string;
}

function formFromPrefill(prefill: ClientMappingPrefill): MappingForm {
  return {
    ...emptyForm,
    sessionId: prefill.kind === 'teammate' ? '' : prefill.sessionId,
    jid: prefill.jid,
    kind: prefill.kind,
    name: prefill.name ?? '',
    phone: prefill.phone ?? '',
  };
}

function formFromMapping(mapping: ClientMapping): MappingForm {
  return {
    sessionId: mapping.sessionId ?? '',
    jid: mapping.jid,
    kind: mapping.kind,
    name: mapping.name,
    phone: mapping.phone ?? '',
    company: mapping.company,
    team: mapping.team ?? '',
    role: mapping.role ?? '',
    timezone: mapping.timezone ?? '',
    status: mapping.status,
    backupOwnerId: mapping.backupOwnerId ?? '',
    sentimentTracking: mapping.sentimentTracking,
    notes: mapping.notes ?? '',
  };
}

/** Empty-string form fields mean "unset" — sent as undefined so the backend keeps them null. */
function toCreatePayload(form: MappingForm): ClientMappingPayload {
  return {
    sessionId: form.kind === 'teammate' ? undefined : form.sessionId.trim() || undefined,
    jid: form.jid.trim(),
    kind: form.kind,
    name: form.name.trim(),
    phone: form.phone.trim() || undefined,
    company: form.company.trim(),
    team: form.team.trim() || undefined,
    role: form.role.trim() || undefined,
    timezone: form.timezone.trim() || undefined,
    status: form.status,
    backupOwnerId: form.backupOwnerId || undefined,
    sentimentTracking: form.sentimentTracking,
    notes: form.notes.trim() || undefined,
  };
}

function toUpdatePayload(form: MappingForm): Partial<Omit<ClientMappingPayload, 'jid' | 'kind' | 'sessionId'>> {
  return {
    name: form.name.trim(),
    phone: form.phone.trim() || null,
    company: form.company.trim(),
    team: form.team.trim() || null,
    role: form.role.trim() || null,
    timezone: form.timezone.trim() || null,
    status: form.status,
    backupOwnerId: form.backupOwnerId || null,
    sentimentTracking: form.sentimentTracking,
    notes: form.notes.trim() || null,
  };
}

export function ClientMappings() {
  const { t } = useTranslation();
  useDocumentTitle(t('clientMappings.title'));
  const { isAdmin } = useRole();
  const toast = useToast();

  const [filterKind, setFilterKind] = useState<ClientMappingKind | ''>('');
  const [filterCompany, setFilterCompany] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const filter = useMemo(
    () => ({
      ...(filterKind ? { kind: filterKind } : {}),
      ...(filterCompany ? { company: filterCompany } : {}),
    }),
    [filterKind, filterCompany],
  );

  const { data: mappings = [], isLoading, isError } = useClientMappingsQuery(filter);
  // Unfiltered, for the backup-owner picker: a mapping outside the active filter must still be
  // selectable as another row's escalation backup.
  const { data: allMappings = [] } = useClientMappingsQuery();
  const { data: sessions = [] } = useSessionsQuery();
  const createMutation = useCreateClientMappingMutation();
  const updateMutation = useUpdateClientMappingMutation();
  const deleteMutation = useDeleteClientMappingMutation();

  const [showModal, setShowModal] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ClientMapping | null>(null);
  const [form, setForm] = useState<MappingForm>(emptyForm);
  const [deleteTarget, setDeleteTarget] = useState<ClientMapping | null>(null);

  const [showImportModal, setShowImportModal] = useState(false);
  const [importSessionId, setImportSessionId] = useState('');
  const [importGroupMembers, setImportGroupMembers] = useState(true);
  const [isImporting, setIsImporting] = useState(false);

  // Arrived here via the Chats page's "Tag as Client" button: open the create modal pre-filled
  // instead of making a rep hunt down and retype a JID by hand. Cleared from history immediately
  // so a back-navigation or refresh doesn't reopen the same prefill.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const prefill = (location.state as { prefill?: ClientMappingPrefill } | null)?.prefill;
    if (!prefill) return;
    setEditingMapping(null);
    setForm(formFromPrefill(prefill));
    setShowModal(true);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for the state this mount arrived with
  }, []);

  const companies = useMemo(() => Array.from(new Set(allMappings.map(m => m.company))).sort(), [allMappings]);
  // Client-side text search over the already-fetched (kind/company-filtered) page: this table is an
  // admin directory sized for a human to scroll, not a paginated dataset, so a free-text backend
  // query param isn't worth the API surface — filtering what's already in memory is instant and
  // needs no round trip.
  const visibleMappings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return mappings;
    return mappings.filter(m =>
      [m.name, m.jid, m.phone, m.company, m.team, m.role].some(field => field?.toLowerCase().includes(q)),
    );
  }, [mappings, searchQuery]);
  // Static for the runtime's lifetime (backed by Intl's zone database), so compute once rather than
  // re-deriving ~400 zone names on every render.
  const timezoneGroups = useMemo(() => groupedTimezones(), []);

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isEditing = !!editingMapping;
  const needsSession = form.kind !== 'teammate';
  const canSave =
    form.jid.trim() && form.name.trim() && form.company.trim() && (!needsSession || form.sessionId.trim());

  const openCreate = () => {
    setEditingMapping(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (mapping: ClientMapping) => {
    setEditingMapping(mapping);
    setForm(formFromMapping(mapping));
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingMapping(null);
    setForm(emptyForm);
  };

  const handleSave = async () => {
    if (!canSave) return;
    try {
      if (editingMapping) {
        await updateMutation.mutateAsync({ id: editingMapping.id, data: toUpdatePayload(form) });
        toast.success(t('clientMappings.toasts.updated'));
      } else {
        await createMutation.mutateAsync(toCreatePayload(form));
        toast.success(t('clientMappings.toasts.created'));
      }
      closeModal();
    } catch (err) {
      toast.error(
        t(editingMapping ? 'clientMappings.toasts.updateFailed' : 'clientMappings.toasts.createFailed'),
        err instanceof Error ? err.message : t('common.unknownError'),
      );
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast.success(t('clientMappings.toasts.deleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(t('clientMappings.toasts.deleteFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  // Bulk-seeds a mapping for every chat WhatsApp already knows about, using only what it already
  // resolved (pushName / saved contact name, the JID itself) — company is left as the UNKNOWN_COMPANY
  // placeholder, which is exactly what marks the row incomplete in the table afterward. One create
  // call per chat/participant rather than a new backend bulk endpoint: this runs once per session,
  // occasionally, over a chat list sized for a human to scroll, not a bulk-data pipeline.
  //
  // A GROUP's own row does not stand in for its members: someone who only ever posts inside a group
  // (never a 1:1 with this account) has no chat of their own, so the chat-list loop above never sees
  // them — that's the exact gap that left real group members out of a previous import. Fetching each
  // group's member list directly (the same info the WhatsApp app's own "Group info" screen shows)
  // closes it; importGroupMembers gates it off for an operator who deliberately wants group-level
  // rows only (a very large group can add a lot of "Unknown"-company rows to sift through).
  const handleImport = async () => {
    if (!importSessionId) return;
    setIsImporting(true);
    try {
      const chats = await sessionApi.getChats(importSessionId);
      const existingKeys = new Set(
        allMappings.filter(m => m.sessionId === importSessionId).map(m => `${m.kind}:${m.jid}`),
      );
      // docs/33 root cause: a group participant is often addressed only by its privacy @lid jid,
      // which never matches this account's own @c.us contact record for the same real person
      // (WhatsApp's own contact store keeps two models for one real contact — verified live: same
      // pushName, same effective id, different `number`). Deduping group members by resolved PHONE
      // as well as by jid stops "Lakshye Kapoor" (or anyone else known both as a group @lid and as a
      // direct @c.us contact) from landing as two separate rows.
      const existingPhones = new Set(
        allMappings
          .filter(m => m.sessionId === importSessionId && m.kind === 'contact' && m.phone)
          .map(m => m.phone as string),
      );
      let created = 0;
      let membersCreated = 0;
      let skipped = 0;
      let failed = 0;

      // getGroupInfo's own participants[].name comes back empty in practice (verified live against
      // a real 15-member group — every entry was undefined) even though this account's address
      // book already resolves most of the same numbers via GET /contacts. One fetch, reused across
      // every group in this run, rather than a per-participant lookup.
      const contactNameById = new Map<string, string>();
      if (importGroupMembers) {
        try {
          const contacts = await contactApi.list(importSessionId);
          for (const contact of contacts) {
            const name = contact.pushName?.trim() || contact.name?.trim();
            if (name) contactNameById.set(contact.id, name);
          }
        } catch {
          // Best-effort enrichment only — group members still import with a raw-id name fallback.
        }
      }
      // Never map the account's own number as if it were a client/contact.
      const ownJid = sessions.find(s => s.id === importSessionId)?.phone
        ? `${sessions.find(s => s.id === importSessionId)!.phone}@c.us`
        : null;

      // Importing every member of every group is easily 100+ sequential creates for a session with
      // several groups — verified live: a real 14-group account tripped the API's own rate limiter
      // (429) partway through, silently dropping the rest. Back off and retry on 429 instead of
      // guessing a safe fixed delay up front (the limit itself, RATE_LIMIT_MEDIUM_LIMIT, is operator-
      // configurable) — fast when nothing is throttled, self-pacing when it is. Generic so the
      // phone-resolution lookup below (docs/33 Phase A) shares the same backoff as the create call —
      // both hit the same rate limiter.
      const withRetry = async <T,>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> => {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            return await fn();
          } catch (err) {
            const status = err instanceof Error ? (err as Error & { status?: number }).status : undefined;
            if (status === 429 && attempt < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, Math.min(2000 * attempt, 15000)));
              continue;
            }
            throw err;
          }
        }
        throw new Error('unreachable');
      };
      const createWithRetry = (payload: ClientMappingPayload) => withRetry(() => createMutation.mutateAsync(payload));

      // Claims `key` before the network round trip settles, so a person who is a member of two
      // groups being imported in the same run is created once, not raced into a duplicate attempt.
      const createOne = async (payload: ClientMappingPayload, key: string): Promise<boolean> => {
        if (existingKeys.has(key)) {
          skipped++;
          return false;
        }
        existingKeys.add(key);
        try {
          await createWithRetry(payload);
          return true;
        } catch {
          failed++;
          existingKeys.delete(key);
          return false;
        }
      };

      for (const chat of chats) {
        const kind: ClientMappingKind = chat.isGroup ? 'group' : 'contact';
        const resolvedName = chat.name?.trim();
        const chatPhone = kind === 'contact' ? (parsePhoneFromJid(chat.id) ?? undefined) : undefined;
        if (
          await createOne(
            {
              sessionId: importSessionId,
              jid: chat.id,
              kind,
              name: resolvedName || chat.id.split('@')[0],
              phone: chatPhone,
              company: UNKNOWN_COMPANY,
            },
            `${kind}:${chat.id}`,
          )
        ) {
          created++;
          // Feed the phone-dedup set (docs/33) so a group member seen later in this same run, whose
          // only address is a @lid this account can't parse a phone from directly, still resolves
          // (via contactApi.resolvePhone) to a phone that matches this row instead of creating a
          // second one.
          if (chatPhone) existingPhones.add(chatPhone);
        }

        if (chat.isGroup && importGroupMembers) {
          try {
            const info = await groupApi.getInfo(importSessionId, chat.id);
            for (const participant of info.participants) {
              if (participant.id === ownJid) continue;
              const participantKey = `contact:${participant.id}`;
              if (existingKeys.has(participantKey)) {
                skipped++;
                continue;
              }

              // Group participants are frequently addressed only by their privacy @lid jid, which
              // parsePhoneFromJid can't read a phone out of. Resolve it the same way the per-sender
              // "add to mapping" button does (docs/33 Phase A) so this person can be matched against
              // an existing @c.us mapping by phone instead of always falling through to a new row.
              let phone = parsePhoneFromJid(participant.id) ?? undefined;
              if (!phone) {
                try {
                  const resolved = await withRetry(() => contactApi.resolvePhone(importSessionId, participant.id));
                  phone = resolved.phone ?? undefined;
                } catch {
                  // Resolution failing (transport/engine error) shouldn't abort the whole group's
                  // import — fall through and create the row under its raw jid, same as before.
                }
              }

              if (phone && existingPhones.has(phone)) {
                // Same real person already mapped under a different jid (their @c.us contact, or a
                // @lid seen earlier this run) — claim the jid too so a re-run skips the network call.
                existingKeys.add(participantKey);
                skipped++;
                continue;
              }

              const memberName =
                contactNameById.get(participant.id) || participant.name?.trim() || participant.id.split('@')[0];
              if (
                await createOne(
                  {
                    sessionId: importSessionId,
                    jid: participant.id,
                    kind: 'contact',
                    name: memberName,
                    phone,
                    company: UNKNOWN_COMPANY,
                  },
                  participantKey,
                )
              ) {
                membersCreated++;
                if (phone) existingPhones.add(phone);
              }
            }
          } catch {
            // A group whose member list can't be fetched (e.g. this account was removed from it)
            // shouldn't abort the whole import — its own chat-level row above already landed.
          }
        }
      }
      toast.success(t('clientMappings.import.done', { created: created + membersCreated, skipped }));
      if (failed > 0) toast.error(t('clientMappings.import.someFailed', { failed }));
      setShowImportModal(false);
      setImportSessionId('');
    } catch (err) {
      toast.error(t('clientMappings.import.failed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setIsImporting(false);
    }
  };

  const backupOwnerOptions = allMappings.filter(m => m.id !== editingMapping?.id);

  if (isLoading) {
    return (
      <div className="client-mappings-page" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="client-mappings-page">
      <PageHeader
        title={t('clientMappings.title')}
        subtitle={t('clientMappings.subtitle')}
        actions={
          isAdmin ? (
            <span className="client-mappings-header-actions">
              <button
                className="btn-secondary"
                onClick={() => setShowImportModal(true)}
                disabled={sessions.length === 0}
                title={sessions.length === 0 ? t('clientMappings.import.noSessions') : undefined}
              >
                <Download size={18} />
                {t('clientMappings.importBtn')}
              </button>
              <button className="btn-primary" onClick={openCreate}>
                <Plus size={18} />
                {t('clientMappings.createBtn')}
              </button>
            </span>
          ) : undefined
        }
      />

      {isError && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('dashboard.loadError')}</span>
        </div>
      )}

      <div className="client-mappings-filters">
        <div className="client-mappings-search">
          <Search size={16} />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('clientMappings.filters.searchPlaceholder')}
            aria-label={t('clientMappings.filters.searchPlaceholder')}
          />
        </div>
        <select
          aria-label={t('clientMappings.filters.allKinds')}
          value={filterKind}
          onChange={e => setFilterKind(e.target.value as ClientMappingKind | '')}
        >
          <option value="">{t('clientMappings.filters.allKinds')}</option>
          {CLIENT_MAPPING_KINDS.map(kind => (
            <option key={kind} value={kind}>
              {t(`clientMappings.kinds.${kind}`)}
            </option>
          ))}
        </select>
        <select
          aria-label={t('clientMappings.filters.allCompanies')}
          value={filterCompany}
          onChange={e => setFilterCompany(e.target.value)}
        >
          <option value="">{t('clientMappings.filters.allCompanies')}</option>
          {companies.map(company => (
            <option key={company} value={company}>
              {company}
            </option>
          ))}
        </select>
      </div>

      <div className="client-mappings-content">
        <div className="mappings-table-container">
          {mappings.length === 0 ? (
            <div className="empty-table-state">
              <Users size={48} strokeWidth={1} />
              <h3>{t('clientMappings.empty.title')}</h3>
              <p>{t('clientMappings.empty.description')}</p>
            </div>
          ) : visibleMappings.length === 0 ? (
            <div className="empty-table-state">
              <Search size={48} strokeWidth={1} />
              <h3>{t('clientMappings.empty.noResultsTitle')}</h3>
              <p>{t('clientMappings.empty.noResultsDescription')}</p>
            </div>
          ) : (
            <table className="mappings-table">
              <thead>
                <tr className="table-row header">
                  <th>{t('clientMappings.columns.name')}</th>
                  <th>{t('clientMappings.columns.kind')}</th>
                  <th>{t('clientMappings.columns.company')}</th>
                  <th>{t('clientMappings.columns.team')}</th>
                  <th>{t('clientMappings.columns.status')}</th>
                  <th>{t('clientMappings.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleMappings.map(mapping => (
                  <tr key={mapping.id} className="table-row">
                    <td>
                      <span className="name-cell">
                        {mapping.name}
                        {isIncompleteMapping(mapping) && (
                          <span className="incomplete-marker" title={t('clientMappings.badges.incomplete')}>
                            <AlertTriangle size={14} />
                          </span>
                        )}
                      </span>
                      <span className="jid-subtext">{mapping.jid}</span>
                    </td>
                    <td>
                      <span className="kind-badge">{t(`clientMappings.kinds.${mapping.kind}`)}</span>
                    </td>
                    <td>{mapping.company}</td>
                    <td>{mapping.team || '—'}</td>
                    <td>
                      <span className={`status-badge ${mapping.status}`}>
                        {t(`clientMappings.statuses.${mapping.status}`)}
                      </span>
                    </td>
                    <td>
                      {isAdmin && (
                        <span className="actions-cell">
                          <button
                            className="icon-btn"
                            onClick={() => openEdit(mapping)}
                            title={t('clientMappings.actions.edit')}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            className="icon-btn danger"
                            onClick={() => setDeleteTarget(mapping)}
                            title={t('common.delete')}
                          >
                            <Trash2 size={16} />
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showModal && (
        <Modal
          open
          onClose={closeModal}
          title={isEditing ? t('clientMappings.modalTitleEdit') : t('clientMappings.modalTitleCreate')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={closeModal}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleSave()} disabled={!canSave || isSaving}>
                {isSaving ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
              </button>
            </>
          }
        >
          <label htmlFor="cm-kind">{t('clientMappings.fields.kind')}</label>
          <select
            id="cm-kind"
            value={form.kind}
            disabled={isEditing}
            onChange={e => setForm({ ...form, kind: e.target.value as ClientMappingKind, sessionId: '' })}
          >
            {CLIENT_MAPPING_KINDS.map(kind => (
              <option key={kind} value={kind}>
                {t(`clientMappings.kinds.${kind}`)}
              </option>
            ))}
          </select>

          {needsSession && (
            <>
              <label htmlFor="cm-session">{t('clientMappings.fields.sessionId')}</label>
              <select
                id="cm-session"
                value={form.sessionId}
                disabled={isEditing}
                onChange={e => setForm({ ...form, sessionId: e.target.value })}
              >
                <option value="">{t('clientMappings.fields.sessionIdPlaceholder')}</option>
                {sessions.map(session => (
                  <option key={session.id} value={session.id}>
                    {session.name}
                  </option>
                ))}
              </select>
              <p className="field-hint">{t('clientMappings.fields.sessionIdHint')}</p>
            </>
          )}

          <label htmlFor="cm-jid">{t('clientMappings.fields.jid')}</label>
          <input
            id="cm-jid"
            value={form.jid}
            disabled={isEditing}
            onChange={e => setForm({ ...form, jid: e.target.value })}
            placeholder={t('clientMappings.fields.jidPlaceholder')}
          />

          <label htmlFor="cm-name">{t('clientMappings.fields.name')}</label>
          <input id="cm-name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />

          <label htmlFor="cm-phone">{t('clientMappings.fields.phone')}</label>
          <input id="cm-phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />

          <label htmlFor="cm-company">{t('clientMappings.fields.company')}</label>
          <input id="cm-company" value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} />

          <label htmlFor="cm-team">{t('clientMappings.fields.team')}</label>
          <input id="cm-team" value={form.team} onChange={e => setForm({ ...form, team: e.target.value })} />

          <label htmlFor="cm-role">{t('clientMappings.fields.role')}</label>
          <input id="cm-role" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} />

          <label htmlFor="cm-timezone">{t('clientMappings.fields.timezone')}</label>
          <select
            id="cm-timezone"
            value={form.timezone}
            onChange={e => setForm({ ...form, timezone: e.target.value })}
          >
            <option value="">{t('clientMappings.fields.timezoneNotSet')}</option>
            {timezoneGroups.map(group => (
              <optgroup key={group.region} label={group.region}>
                {group.zones.map(zone => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <label htmlFor="cm-status">{t('clientMappings.fields.status')}</label>
          <select
            id="cm-status"
            value={form.status}
            onChange={e => setForm({ ...form, status: e.target.value as ClientMappingStatus })}
          >
            {CLIENT_MAPPING_STATUSES.map(status => (
              <option key={status} value={status}>
                {t(`clientMappings.statuses.${status}`)}
              </option>
            ))}
          </select>

          <label htmlFor="cm-backup">{t('clientMappings.fields.backupOwnerId')}</label>
          <select
            id="cm-backup"
            value={form.backupOwnerId}
            onChange={e => setForm({ ...form, backupOwnerId: e.target.value })}
          >
            <option value="">{t('clientMappings.fields.backupOwnerNone')}</option>
            {backupOwnerOptions.map(owner => (
              <option key={owner.id} value={owner.id}>
                {owner.name} ({owner.company})
              </option>
            ))}
          </select>

          {form.kind === 'group' && (
            <label className="checkbox-field" htmlFor="cm-sentiment">
              <input
                id="cm-sentiment"
                type="checkbox"
                checked={form.sentimentTracking}
                onChange={e => setForm({ ...form, sentimentTracking: e.target.checked })}
              />
              {t('clientMappings.fields.sentimentTracking')}
            </label>
          )}

          <label htmlFor="cm-notes">{t('clientMappings.fields.notes')}</label>
          <textarea
            id="cm-notes"
            rows={3}
            value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })}
            placeholder={t('clientMappings.fields.notesPlaceholder')}
          />
        </Modal>
      )}

      {showImportModal && (
        <Modal
          open
          onClose={() => (isImporting ? undefined : setShowImportModal(false))}
          title={t('clientMappings.import.title')}
          closeLabel={t('common.close')}
          hideCloseButton={isImporting}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setShowImportModal(false)} disabled={isImporting}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void handleImport()}
                disabled={!importSessionId || isImporting}
              >
                {isImporting ? <Loader2 className="animate-spin" size={16} /> : t('clientMappings.import.confirmBtn')}
              </button>
            </>
          }
        >
          <p className="field-hint">{t('clientMappings.import.description')}</p>
          <label htmlFor="cm-import-session">{t('clientMappings.fields.sessionId')}</label>
          <select
            id="cm-import-session"
            value={importSessionId}
            disabled={isImporting}
            onChange={e => setImportSessionId(e.target.value)}
          >
            <option value="">{t('clientMappings.fields.sessionIdPlaceholder')}</option>
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>

          <label className="checkbox-field" htmlFor="cm-import-members">
            <input
              id="cm-import-members"
              type="checkbox"
              checked={importGroupMembers}
              disabled={isImporting}
              onChange={e => setImportGroupMembers(e.target.checked)}
            />
            {t('clientMappings.import.includeGroupMembers')}
          </label>
          <p className="field-hint">{t('clientMappings.import.includeGroupMembersHint')}</p>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          open
          onClose={() => setDeleteTarget(null)}
          title={t('clientMappings.confirm.deleteTitle')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => void handleDelete()} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {t('common.delete')}
              </button>
            </>
          }
        >
          <div className="confirm-icon-wrapper">
            <AlertTriangle size={48} className="confirm-warning-icon" />
          </div>
          <p className="confirm-message">
            <Trans
              i18nKey="clientMappings.confirm.deleteMessage"
              values={{ name: deleteTarget.name }}
              components={{ strong: <strong /> }}
            />
          </p>
        </Modal>
      )}
    </div>
  );
}
