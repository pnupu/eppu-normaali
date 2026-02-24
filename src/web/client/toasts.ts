import { TOAST_IMAGES, TOAST_MS } from './constants';
import { dom, escapeHtml } from './dom';
import { ToastMood } from './types';

let activeToast: HTMLElement | null = null;
let activeToastTimer: number | null = null;

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function showToast(mood: ToastMood, lines: readonly string[]): void {
  if (activeToast) {
    activeToast.remove();
    activeToast = null;
  }
  if (activeToastTimer) {
    window.clearTimeout(activeToastTimer);
    activeToastTimer = null;
  }

  const toast = document.createElement('article');
  const imagePool = TOAST_IMAGES[mood] || TOAST_IMAGES.neutral;
  const image = randomItem(imagePool);
  const text = randomItem(lines);

  toast.className = 'toast';
  toast.innerHTML = `
    <img src="${image}" alt="Epun reaktio">
    <p>${escapeHtml(text)}</p>
  `;
  activeToast = toast;
  dom.toastStack.appendChild(toast);

  activeToastTimer = window.setTimeout(() => {
    toast.remove();
    if (activeToast === toast) {
      activeToast = null;
    }
    activeToastTimer = null;
  }, TOAST_MS);
}
