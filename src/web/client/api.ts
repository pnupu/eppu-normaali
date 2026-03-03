import { SEARCH_RESULT_LIMIT } from './constants';
import { appState } from './state';
import {
  ApiResult,
  AuthProfile,
  PlaybackStateMap,
  PlaylistDetailResponse,
  PlaylistListResponse,
  PlaylistOperationResult,
  VoiceCommandResponse,
  VoiceKeywordListResponse,
  WebConfig,
  WebSearchResult
} from './types';

function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  if (!appState.accessToken) return base;
  return { ...base, 'X-Eppu-Token': appState.accessToken };
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = authHeaders((options.headers || {}) as Record<string, string>);
  return fetch(url, { ...options, headers });
}

function popQueryParam(key: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(key);
  if (value !== null) {
    params.delete(key);
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
  }
  return value;
}

export function initAccessTokenFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const tokenFromUrl = params.get('token');
  if (tokenFromUrl) {
    window.sessionStorage.setItem('eppu_access_token', tokenFromUrl);
    params.delete('token');
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
  }
  appState.accessToken = window.sessionStorage.getItem('eppu_access_token') || '';
}

export function initDiscordLoginTokenFromUrl(): string | null {
  return popQueryParam('login_token');
}

export async function loadWebConfig(): Promise<void> {
  try {
    const res = await apiFetch('/api/web-config');
    if (!res.ok) return;
    const config = await res.json() as WebConfig;

    appState.authRequired = config.authRequired !== false;
    appState.localMode = !!config.localMode;
    appState.exposureMode = config.exposureMode || 'local';
    appState.requireAccessToken = !!config.requireAccessToken;
    appState.defaultGuildId = typeof config.defaultGuildId === 'string' ? config.defaultGuildId : '';
  } catch {
    // Keep defaults.
  }
}

export async function exchangeDiscordLoginToken(loginToken: string): Promise<ApiResult> {
  const res = await apiFetch('/api/auth/link-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: loginToken }),
  });
  return res.json();
}

export async function fetchAuthProfile(): Promise<AuthProfile | null> {
  const res = await apiFetch('/api/auth/me');
  if (!res.ok) return null;
  return res.json() as Promise<AuthProfile>;
}

export async function fetchPlaybackState(): Promise<{
  kind: 'ok' | 'not-modified' | 'unauthorized' | 'error';
  etag?: string;
  state?: PlaybackStateMap;
}> {
  try {
    const headers: Record<string, string> = {};
    if (appState.stateEtag) {
      headers['If-None-Match'] = appState.stateEtag;
    }
    const res = await apiFetch('/api/state', { headers });

    if (res.status === 304) {
      return { kind: 'not-modified' };
    }
    if (res.status === 401) {
      return { kind: 'unauthorized' };
    }
    if (!res.ok) {
      return { kind: 'error' };
    }

    return {
      kind: 'ok',
      etag: res.headers.get('ETag') || '',
      state: await res.json() as PlaybackStateMap,
    };
  } catch {
    return { kind: 'error' };
  }
}

export async function postApi(path: string, payload: Record<string, unknown>): Promise<ApiResult> {
  const res = await apiFetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId: appState.currentGuild, ...payload }),
  });
  return res.json() as Promise<ApiResult>;
}

export async function postVoiceCommand(transcript: string): Promise<VoiceCommandResponse> {
  const res = await apiFetch('/api/voice-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId: appState.currentGuild, transcript }),
  });
  return res.json() as Promise<VoiceCommandResponse>;
}

export async function fetchVoiceKeywords(
  query: string,
  cursor: string | null,
  limit: number
): Promise<VoiceKeywordListResponse> {
  const params = new URLSearchParams();
  if (query.trim()) params.set('query', query.trim());
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(limit));
  const res = await apiFetch(`/api/voice-keywords?${params.toString()}`);
  return res.json() as Promise<VoiceKeywordListResponse>;
}

export async function upsertVoiceKeywordApi(
  phrase: string,
  url: string
): Promise<{ ok?: boolean; item?: unknown; error?: string }> {
  const res = await apiFetch('/api/voice-keywords', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phrase, url }),
  });
  return res.json() as Promise<{ ok?: boolean; item?: unknown; error?: string }>;
}

export async function deleteVoiceKeywordApi(phrase: string): Promise<ApiResult> {
  const res = await apiFetch(`/api/voice-keywords/${encodeURIComponent(phrase)}`, {
    method: 'DELETE',
  });
  return res.json() as Promise<ApiResult>;
}

export async function searchYouTube(query: string): Promise<{ ok: boolean; error?: string; results?: WebSearchResult[] }> {
  const res = await apiFetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: SEARCH_RESULT_LIMIT }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    return { ok: false, error: data.error || 'Haku epäonnistui' };
  }

  return {
    ok: true,
    results: Array.isArray(data.results) ? (data.results as WebSearchResult[]) : [],
  };
}

async function parseApiJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

export async function fetchPlaylists(query: string, cursor: string | null, limit: number): Promise<PlaylistListResponse> {
  const params = new URLSearchParams();
  if (query.trim()) params.set('query', query.trim());
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(limit));
  const res = await apiFetch(`/api/playlists?${params.toString()}`);
  return parseApiJson<PlaylistListResponse>(res);
}

export async function createPlaylistApi(name: string): Promise<{ ok?: boolean; playlist?: any; error?: string }> {
  const res = await apiFetch('/api/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return parseApiJson(res);
}

export async function renamePlaylistApi(playlistId: string, name: string): Promise<{ ok?: boolean; playlist?: any; error?: string }> {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return parseApiJson(res);
}

export async function deletePlaylistApi(playlistId: string): Promise<ApiResult> {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}`, {
    method: 'DELETE',
  });
  return parseApiJson<ApiResult>(res);
}

export async function fetchPlaylistDetail(
  playlistId: string,
  songQuery: string,
  songCursor: string | null,
  songLimit: number
): Promise<PlaylistDetailResponse> {
  const params = new URLSearchParams();
  if (songQuery.trim()) params.set('songQuery', songQuery.trim());
  if (songCursor) params.set('songCursor', songCursor);
  params.set('songLimit', String(songLimit));
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}?${params.toString()}`);
  return parseApiJson<PlaylistDetailResponse>(res);
}

export async function addPlaylistSongApi(
  playlistId: string,
  url: string
): Promise<{ ok?: boolean; result?: PlaylistOperationResult; error?: string }> {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/songs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return parseApiJson(res);
}

export async function addPlaylistSongsBulkApi(
  playlistId: string,
  urls: string[]
): Promise<{ ok?: boolean; result?: PlaylistOperationResult; error?: string }> {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/songs/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  return parseApiJson(res);
}

export async function removePlaylistSongApi(playlistId: string, songId: string): Promise<ApiResult> {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/songs/${encodeURIComponent(songId)}`, {
    method: 'DELETE',
  });
  return parseApiJson<ApiResult>(res);
}

export async function movePlaylistSongApi(playlistId: string, fromIndex: number, toIndex: number): Promise<ApiResult> {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/songs/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromIndex, toIndex }),
  });
  return parseApiJson<ApiResult>(res);
}

export async function playPlaylistApi(playlistId: string, guildId: string, shuffle: boolean): Promise<{ ok?: boolean; queued?: number; failed?: number; error?: string; noop?: boolean; message?: string }> {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId, shuffle }),
  });
  return parseApiJson(res);
}

export async function createPlaylistFromQueueApi(
  guildId: string,
  name: string,
  includeCurrent: boolean,
  selectedIndices?: number[]
): Promise<{ ok?: boolean; playlist?: any; result?: PlaylistOperationResult; error?: string }> {
  const res = await apiFetch('/api/playlists/from-queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId, name, includeCurrent, selectedIndices }),
  });
  return parseApiJson(res);
}

export async function copyQueueToPlaylistApi(
  playlistId: string,
  guildId: string,
  includeCurrent: boolean,
  selectedIndices?: number[]
): Promise<{ ok?: boolean; result?: PlaylistOperationResult; error?: string }> {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/from-queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId, includeCurrent, selectedIndices }),
  });
  return parseApiJson(res);
}

export async function importYouTubePlaylistApi(
  name: string,
  url: string
): Promise<{ ok?: boolean; playlist?: any; result?: PlaylistOperationResult; sourceTitle?: string; error?: string }> {
  const res = await apiFetch('/api/playlists/import-youtube', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url }),
  });
  return parseApiJson(res);
}
