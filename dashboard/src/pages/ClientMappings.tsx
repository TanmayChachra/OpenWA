import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, Loader2, Pencil, Plus, Trash2, Users } from 'lucide-react';
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
import './ClientMappings.css';

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
  timezone: '',
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
            <button className="btn-primary" onClick={openCreate}>
              <Plus size={18} />
              {t('clientMappings.createBtn')}
            </button>
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
                {mappings.map(mapping => (
                  <tr key={mapping.id} className="table-row">
                    <td>
                      <span className="name-cell">{mapping.name}</span>
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
          <input
            id="cm-timezone"
            value={form.timezone}
            onChange={e => setForm({ ...form, timezone: e.target.value })}
            placeholder={t('clientMappings.fields.timezonePlaceholder')}
          />

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
