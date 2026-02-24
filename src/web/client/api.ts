import { SEARCH_RESULT_LIMIT } from './constants';
import { appState } from './state';
import { ApiResult, AuthProfile, PlaybackStateMap, WebConfig, WebSearchResult } from './types';

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
