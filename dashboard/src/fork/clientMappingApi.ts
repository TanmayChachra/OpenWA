// Fork-only Client Mapping API client. Lives outside services/api.ts so an upstream sync never
// conflicts on that file; it only needs `request` exported from there.
import { request } from '../services/api';

// Mirrors the backend ClientMapping entity (src/modules/client-mapping/entities/client-mapping.entity.ts).
export type ClientMappingKind = 'contact' | 'group' | 'teammate';
export const CLIENT_MAPPING_KINDS: readonly ClientMappingKind[] = ['contact', 'group', 'teammate'];
export type ClientMappingStatus = 'active' | 'inactive';
export const CLIENT_MAPPING_STATUSES: readonly ClientMappingStatus[] = ['active', 'inactive'];

export interface ClientMapping {
  id: string;
  sessionId: string | null;
  jid: string;
  kind: ClientMappingKind;
  name: string;
  phone: string | null;
  company: string;
  team: string | null;
  role: string | null;
  timezone: string | null;
  status: ClientMappingStatus;
  backupOwnerId: string | null;
  sentimentTracking: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientMappingPayload {
  sessionId?: string;
  jid: string;
  kind: ClientMappingKind;
  name: string;
  phone?: string | null;
  company: string;
  team?: string | null;
  role?: string | null;
  timezone?: string | null;
  status?: ClientMappingStatus;
  backupOwnerId?: string | null;
  sentimentTracking?: boolean;
  notes?: string | null;
}

// docs/33 Phase B: request/response shape for the shared "does this already exist" + identity
// resolution endpoint every automatic writer (auto-tag, Import from Chats) should use instead of
// its own create-if-missing logic.
export interface ResolveAndUpsertClientMappingPayload {
  sessionId: string;
  jid: string;
  kind: 'contact' | 'group';
  nameHint?: string;
  phoneHint?: string | null;
  company?: string;
}

export interface ResolveAndUpsertClientMappingResult {
  mapping: ClientMapping;
  created: boolean;
}

// ADMIN, unscoped keys only - see src/modules/client-mapping
export const clientMappingApi = {
  list: (filter?: { sessionId?: string; kind?: ClientMappingKind; company?: string }) => {
    const params = new URLSearchParams();
    if (filter?.sessionId) params.set('sessionId', filter.sessionId);
    if (filter?.kind) params.set('kind', filter.kind);
    if (filter?.company) params.set('company', filter.company);
    const query = params.toString();
    return request<ClientMapping[]>(`/client-mappings${query ? `?${query}` : ''}`);
  },
  create: (data: ClientMappingPayload) =>
    request<ClientMapping>('/client-mappings', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Omit<ClientMappingPayload, 'jid' | 'kind' | 'sessionId'>>) =>
    request<ClientMapping>(`/client-mappings/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/client-mappings/${id}`, { method: 'DELETE' }),
  // Resolves @lid -> phone server-side (shared, cached table) and dedupes by phone before jid - see
  // docs/33 Phase B. Used by bulk import instead of create() so the exact bug fixed once in the
  // backend (Athar Abbas / Lakshye Kapoor: one real person, two jids) can't resurface here.
  resolveAndUpsert: (data: ResolveAndUpsertClientMappingPayload) =>
    request<ResolveAndUpsertClientMappingResult>('/client-mappings/resolve-and-upsert', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Group participants, used by the Client Mappings group-member import.
export interface GroupParticipant {
  /** Participant id in the engine's native format (`…@c.us`, `…@s.whatsapp.net`, or `…@lid`). */
  id: string;
  /** MSISDN digits the engine reported - best-effort; may actually be a @lid's local part, not a
   * real phone number, so treat this as informational and derive an authoritative phone via
   * parsePhoneFromJid(id) instead of trusting this field directly. */
  number: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface GroupInfo {
  id: string;
  name: string;
  participants: GroupParticipant[];
}

export const groupApi = {
  getInfo: (sessionId: string, groupId: string) =>
    request<GroupInfo>(`/sessions/${sessionId}/groups/${encodeURIComponent(groupId)}`),
};
