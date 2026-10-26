import type {
  BulkResult,
  EnqueueResponse,
  PlaybackStateMap,
  PlaylistDetail,
  PlaylistSummary,
  SearchSource,
  Track,
  WebConfig,
} from './types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let accessToken = '';

/** The optional tunnel access token arrives once as ?token= and lives in sessionStorage afterwards. */
export function initAccessToken(): boolean {
  const fromUrl = popQueryParam('token');
  if (fromUrl) window.sessionStorage.setItem('eppu_access_token', fromUrl);
  accessToken = window.sessionStorage.getItem('eppu_access_token') || '';
  return !!accessToken;
}

export function popQueryParam(key: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(key);
  if (value !== null) {
    params.delete(key);
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }
  return value;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return accessToken ? { ...extra, 'X-Eppu-Token': accessToken } : extra;
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || data?.error) {
    throw new ApiError(data?.error || `Palvelin vastasi virheellä ${res.status}.`, res.status);
  }
  return data as T;
}

export const api = {
  config: () => request<WebConfig>('/api/web-config'),
  me: () => request<{ name?: string; email?: string; error?: string }>('/api/auth/me'),
  linkLogin: (token: string) => request<{ ok: boolean }>('/api/auth/link-login', 'POST', { token }),

  async state(etag: string): Promise<{ notModified: true } | { notModified: false; etag: string; state: PlaybackStateMap }> {
    const res = await fetch('/api/state', { headers: headers(etag ? { 'If-None-Match': etag } : {}) });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    return { notModified: false, etag: res.headers.get('ETag') || '', state: await res.json() };
  },

  search: (query: string, source: SearchSource) =>
    request<{ results: Track[] }>('/api/search', 'POST', { query, source, limit: 8 }),
  play: (guildId: string, payload: { input: string } | { track: Track }) =>
    request<EnqueueResponse>('/api/play', 'POST', { guildId, ...payload }),
  control: (guildId: string, action: 'pause' | 'skip') =>
    request<{ ok: boolean; paused?: boolean }>(`/api/${action}`, 'POST', { guildId }),
  remove: (guildId: string, index: number) => request('/api/remove', 'POST', { guildId, index }),
  move: (guildId: string, from: number, to: number) => request('/api/move', 'POST', { guildId, from, to }),
  volume: (guildId: string, volume: number) => request('/api/volume', 'POST', { guildId, volume }),

  async playlists(): Promise<{ items: PlaylistSummary[] }> {
    const items: PlaylistSummary[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: PlaylistSummary[]; nextCursor: string | null } = await request(
        `/api/playlists?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      );
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return { items };
  },
  async playlist(id: string): Promise<{ playlist: PlaylistDetail }> {
    const base = `/api/playlists/${encodeURIComponent(id)}?songLimit=200`;
    const { playlist } = await request<{ playlist: PlaylistDetail }>(base);
    while (playlist.songNextCursor) {
      const { playlist: page } = await request<{ playlist: PlaylistDetail }>(
        `${base}&songCursor=${encodeURIComponent(playlist.songNextCursor)}`
      );
      playlist.songs.push(...page.songs);
      playlist.songNextCursor = page.songNextCursor;
    }
    return { playlist };
  },
  createPlaylist: (name: string) => request<{ playlist: PlaylistSummary }>('/api/playlists', 'POST', { name }),
  renamePlaylist: (id: string, name: string) =>
    request<{ playlist: PlaylistSummary }>(`/api/playlists/${encodeURIComponent(id)}`, 'PATCH', { name }),
  deletePlaylist: (id: string) => request(`/api/playlists/${encodeURIComponent(id)}`, 'DELETE'),
  importPlaylist: (url: string) =>
    request<{ playlist: PlaylistSummary; result: BulkResult }>('/api/playlists/import', 'POST', { url }),
  addToPlaylist: (id: string, payload: { input: string } | { track: Track }) =>
    request<{ result: BulkResult }>(`/api/playlists/${encodeURIComponent(id)}/songs`, 'POST', payload),
  removeFromPlaylist: (id: string, songId: string) =>
    request(`/api/playlists/${encodeURIComponent(id)}/songs/${encodeURIComponent(songId)}`, 'DELETE'),
  moveInPlaylist: (id: string, fromIndex: number, toIndex: number) =>
    request(`/api/playlists/${encodeURIComponent(id)}/songs/move`, 'POST', { fromIndex, toIndex }),
  playPlaylist: (id: string, guildId: string, shuffle: boolean) =>
    request<{ queued?: number; noop?: boolean; message?: string }>(
      `/api/playlists/${encodeURIComponent(id)}/play`, 'POST', { guildId, shuffle }
    ),
  queueToPlaylist: (guildId: string, name: string) =>
    request<{ playlist: PlaylistSummary; result: BulkResult }>('/api/playlists/from-queue', 'POST', { guildId, name, includeCurrent: true }),
};
