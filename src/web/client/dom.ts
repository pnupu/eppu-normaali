import { StatusTone } from './types';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required element #${id}`);
  }
  return el as T;
}

function byIdOptional<T extends HTMLElement>(
  id: string,
  tagName: keyof HTMLElementTagNameMap = 'div'
): T {
  const el = document.getElementById(id);
  if (el) {
    return el as T;
  }
  const stub = document.createElement(tagName);
  stub.id = id;
  stub.classList.add('hidden');
  return stub as T;
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
  pttBtn: byIdOptional<HTMLButtonElement>('pttBtn', 'button'),
  voiceDebugTranscript: byIdOptional<HTMLElement>('voiceDebugTranscript', 'p'),
  voiceStatus: byIdOptional<HTMLElement>('voiceStatus', 'p'),
  voiceKeywordForm: byIdOptional<HTMLFormElement>('voiceKeywordForm', 'form'),
  voiceKeywordPhraseInput: byIdOptional<HTMLInputElement>('voiceKeywordPhraseInput', 'input'),
  voiceKeywordUrlInput: byIdOptional<HTMLInputElement>('voiceKeywordUrlInput', 'input'),
  voiceKeywordList: byIdOptional<HTMLElement>('voiceKeywordList'),
  voiceKeywordLoadMoreBtn: byIdOptional<HTMLButtonElement>('voiceKeywordLoadMoreBtn', 'button'),
  voiceKeywordStatus: byIdOptional<HTMLElement>('voiceKeywordStatus', 'p'),
  userInfo: byId<HTMLElement>('userInfo'),
  toastStack: byId<HTMLElement>('toastStack'),
  urlInput: byId<HTMLInputElement>('urlInput'),
  playlistList: byIdOptional<HTMLElement>('playlistList'),
  playlistLoadMoreBtn: byIdOptional<HTMLButtonElement>('playlistLoadMoreBtn', 'button'),
  playlistSearchInput: byIdOptional<HTMLInputElement>('playlistSearchInput', 'input'),
  createPlaylistBtn: byIdOptional<HTMLButtonElement>('createPlaylistBtn', 'button'),
  playlistTitle: byIdOptional<HTMLElement>('playlistTitle', 'h3'),
  renamePlaylistBtn: byIdOptional<HTMLButtonElement>('renamePlaylistBtn', 'button'),
  deletePlaylistBtn: byIdOptional<HTMLButtonElement>('deletePlaylistBtn', 'button'),
  playPlaylistBtn: byIdOptional<HTMLButtonElement>('playPlaylistBtn', 'button'),
  playPlaylistShuffleBtn: byIdOptional<HTMLButtonElement>('playPlaylistShuffleBtn', 'button'),
  playlistSongForm: byIdOptional<HTMLFormElement>('playlistSongForm', 'form'),
  playlistSongUrlInput: byIdOptional<HTMLInputElement>('playlistSongUrlInput', 'input'),
  playlistSongList: byIdOptional<HTMLElement>('playlistSongList'),
  playlistSongSearchInput: byIdOptional<HTMLInputElement>('playlistSongSearchInput', 'input'),
  playlistSongsLoadMoreBtn: byIdOptional<HTMLButtonElement>('playlistSongsLoadMoreBtn', 'button'),
  playlistStatus: byIdOptional<HTMLElement>('playlistStatus', 'p'),
  saveQueueToPlaylistBtn: byIdOptional<HTMLButtonElement>('saveQueueToPlaylistBtn', 'button'),
  saveSelectedQueueBtn: byIdOptional<HTMLButtonElement>('saveSelectedQueueBtn', 'button'),
  createPlaylistFromQueueBtn: byIdOptional<HTMLButtonElement>('createPlaylistFromQueueBtn', 'button'),
  playlistImportForm: byIdOptional<HTMLFormElement>('playlistImportForm', 'form'),
  playlistImportNameInput: byIdOptional<HTMLInputElement>('playlistImportNameInput', 'input'),
  playlistImportUrlInput: byIdOptional<HTMLInputElement>('playlistImportUrlInput', 'input'),
  queueSelectModal: byIdOptional<HTMLElement>('queueSelectModal'),
  closeQueueSelectBtn: byIdOptional<HTMLButtonElement>('closeQueueSelectBtn', 'button'),
  queueSelectList: byIdOptional<HTMLElement>('queueSelectList'),
  queueSelectStatus: byIdOptional<HTMLElement>('queueSelectStatus', 'p'),
  queueSelectConfirmBtn: byIdOptional<HTMLButtonElement>('queueSelectConfirmBtn', 'button'),
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
