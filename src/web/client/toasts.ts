import { TOAST_IMAGES, TOAST_MS } from './constants';
import type { ToastMood } from './types';

let activeToast: HTMLElement | null = null;
let activeTimer = 0;

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** Martti Syrjä reacts. One toast at a time; a new one replaces the old. */
export function showToast(mood: ToastMood, lines: readonly string[]): void {
  activeToast?.remove();
  window.clearTimeout(activeTimer);

  const toast = document.createElement('article');
  toast.className = 'toast';
  const img = document.createElement('img');
  img.src = randomItem(TOAST_IMAGES[mood] || TOAST_IMAGES.neutral);
  img.alt = '';
  const text = document.createElement('p');
  text.textContent = randomItem(lines);
  toast.append(img, text);

  document.getElementById('toastStack')?.appendChild(toast);
  activeToast = toast;
  activeTimer = window.setTimeout(() => {
    toast.remove();
    if (activeToast === toast) activeToast = null;
  }, TOAST_MS);
}
