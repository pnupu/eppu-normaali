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
  userInfo: byId<HTMLElement>('userInfo'),
  toastStack: byId<HTMLElement>('toastStack'),
  urlInput: byId<HTMLInputElement>('urlInput'),
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
