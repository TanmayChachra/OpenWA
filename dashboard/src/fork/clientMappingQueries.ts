// Fork-only Client Mapping query hooks, kept out of hooks/queries.ts so an upstream sync never
// conflicts on that file.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clientMappingApi, type ClientMappingKind, type ClientMappingPayload } from './clientMappingApi';

export const clientMappingKeys = {
  list: (filter?: { sessionId?: string; kind?: ClientMappingKind; company?: string }) =>
    ['clientMappings', filter ?? {}] as const,
};

// ── Client Mapping Queries ───────────────────────────────────────────

export function useClientMappingsQuery(
  filter?: { sessionId?: string; kind?: ClientMappingKind; company?: string },
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: clientMappingKeys.list(filter),
    queryFn: () => clientMappingApi.list(filter),
    staleTime: 30_000,
    enabled: options?.enabled,
  });
}

export function useCreateClientMappingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ClientMappingPayload) => clientMappingApi.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clientMappings'] });
    },
  });
}

export function useUpdateClientMappingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<Omit<ClientMappingPayload, 'jid' | 'kind' | 'sessionId'>>;
    }) => clientMappingApi.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clientMappings'] });
    },
  });
}

export function useDeleteClientMappingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => clientMappingApi.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clientMappings'] });
    },
  });
}
