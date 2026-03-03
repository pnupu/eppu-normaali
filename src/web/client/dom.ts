import { StatusTone } from './types';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required element #${id}`);
  }
  return el as T;
}

export const dom = {
  mainSection: byId<HTMLElement>('mainSection'),
  loginSection: byId<HTMLElement>('loginSection'),
  loginHint: byId<HTMLElement>('loginHint'),
  addForm: byId<HTMLFormElement>('addForm'),
  searchForm: byId<HTMLFormElement>('searchForm'),
  searchModal: byId<HTMLElement>('searchModal'),
  openSearchBtn: byId<HTMLButtonElement>('openSearchBtn'),
  closeSearchBtn: byId<HTMLButtonElement>('closeSearchBtn'),
  pauseBtn: byId<HTMLButtonElement>('pauseBtn'),
  skipBtn: byId<HTMLButtonElement>('skipBtn'),
  queueList: byId<HTMLElement>('queueList'),
  addStatus: byId<HTMLElement>('addStatus'),
  searchStatus: byId<HTMLElement>('searchStatus'),
  pollStatus: byId<HTMLElement>('pollStatus'),
  nowPlayingCard: byId<HTMLElement>('nowPlayingCard'),
  nowPlayingTitle: byId<HTMLElement>('nowPlayingTitle'),
  nowPlayingMeta: byId<HTMLElement>('nowPlayingMeta'),
  searchInput: byId<HTMLInputElement>('searchInput'),
  searchResults: byId<HTMLElement>('searchResults'),
  pttBtn: byId<HTMLButtonElement>('pttBtn'),
  voiceDebugTranscript: byId<HTMLElement>('voiceDebugTranscript'),
  voiceStatus: byId<HTMLElement>('voiceStatus'),
  voiceKeywordForm: byId<HTMLFormElement>('voiceKeywordForm'),
  voiceKeywordPhraseInput: byId<HTMLInputElement>('voiceKeywordPhraseInput'),
  voiceKeywordUrlInput: byId<HTMLInputElement>('voiceKeywordUrlInput'),
  voiceKeywordList: byId<HTMLElement>('voiceKeywordList'),
  voiceKeywordLoadMoreBtn: byId<HTMLButtonElement>('voiceKeywordLoadMoreBtn'),
  voiceKeywordStatus: byId<HTMLElement>('voiceKeywordStatus'),
  userInfo: byId<HTMLElement>('userInfo'),
  toastStack: byId<HTMLElement>('toastStack'),
  urlInput: byId<HTMLInputElement>('urlInput'),
  playlistList: byId<HTMLElement>('playlistList'),
  playlistLoadMoreBtn: byId<HTMLButtonElement>('playlistLoadMoreBtn'),
  playlistSearchInput: byId<HTMLInputElement>('playlistSearchInput'),
  createPlaylistBtn: byId<HTMLButtonElement>('createPlaylistBtn'),
  playlistTitle: byId<HTMLElement>('playlistTitle'),
  renamePlaylistBtn: byId<HTMLButtonElement>('renamePlaylistBtn'),
  deletePlaylistBtn: byId<HTMLButtonElement>('deletePlaylistBtn'),
  playPlaylistBtn: byId<HTMLButtonElement>('playPlaylistBtn'),
  playPlaylistShuffleBtn: byId<HTMLButtonElement>('playPlaylistShuffleBtn'),
  playlistSongForm: byId<HTMLFormElement>('playlistSongForm'),
  playlistSongUrlInput: byId<HTMLInputElement>('playlistSongUrlInput'),
  playlistSongList: byId<HTMLElement>('playlistSongList'),
  playlistSongSearchInput: byId<HTMLInputElement>('playlistSongSearchInput'),
  playlistSongsLoadMoreBtn: byId<HTMLButtonElement>('playlistSongsLoadMoreBtn'),
  playlistStatus: byId<HTMLElement>('playlistStatus'),
  saveQueueToPlaylistBtn: byId<HTMLButtonElement>('saveQueueToPlaylistBtn'),
  saveSelectedQueueBtn: byId<HTMLButtonElement>('saveSelectedQueueBtn'),
  createPlaylistFromQueueBtn: byId<HTMLButtonElement>('createPlaylistFromQueueBtn'),
  playlistImportForm: byId<HTMLFormElement>('playlistImportForm'),
  playlistImportNameInput: byId<HTMLInputElement>('playlistImportNameInput'),
  playlistImportUrlInput: byId<HTMLInputElement>('playlistImportUrlInput'),
  queueSelectModal: byId<HTMLElement>('queueSelectModal'),
  closeQueueSelectBtn: byId<HTMLButtonElement>('closeQueueSelectBtn'),
  queueSelectList: byId<HTMLElement>('queueSelectList'),
  queueSelectStatus: byId<HTMLElement>('queueSelectStatus'),
  queueSelectConfirmBtn: byId<HTMLButtonElement>('queueSelectConfirmBtn'),
};

export function setVisible(el: HTMLElement, visible: boolean): void {
  el.classList.toggle('hidden', !visible);
}

export function escapeHtml(value: string | null | undefined): string {
  const tmp = document.createElement('div');
  tmp.textContent = value || '';
  return tmp.innerHTML;
}

export function setStatus(el: HTMLElement, text: string, tone: StatusTone = 'info'): void {
  const color = tone === 'error' ? '#ff7a9b' : tone === 'ok' ? '#83f8b8' : '#45d0ff';
  el.textContent = text;
  el.style.color = color;
  setVisible(el, true);
  window.setTimeout(() => setVisible(el, false), 2200);
}

export function setLoginHint(text: string, isError = false): void {
  dom.loginHint.textContent = text;
  dom.loginHint.style.color = isError ? '#ff7a9b' : '';
}
