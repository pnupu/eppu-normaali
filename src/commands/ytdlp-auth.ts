import fs from 'fs';
import path from 'path';

type AuthMode = 'none' | 'cookies-file' | 'browser';

interface AuthConfig {
  mode: AuthMode;
  cookiesPath?: string;
  browserSpec?: string;
}

let authLogPrinted = false;

function resolveCookiesPath(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(process.cwd(), trimmed);
  return fs.existsSync(resolved) ? resolved : null;
}

function getAuthConfig(): AuthConfig {
  const browserSpec = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (browserSpec) {
    return { mode: 'browser', browserSpec };
  }

  const configuredPath = process.env.YTDLP_COOKIES_PATH?.trim();
  if (configuredPath) {
    const resolved = resolveCookiesPath(configuredPath);
    if (resolved) {
      return { mode: 'cookies-file', cookiesPath: resolved };
    }
  }

  const defaultPath = path.resolve(process.cwd(), 'cookies.txt');
  if (fs.existsSync(defaultPath)) {
    return { mode: 'cookies-file', cookiesPath: defaultPath };
  }

  return { mode: 'none' };
}

export function logYtDlpAuthContext(): void {
  if (authLogPrinted) return;
  authLogPrinted = true;

  const auth = getAuthConfig();
  if (auth.mode === 'browser') {
    console.log(`[yt-dlp] Auth mode: cookies-from-browser (${auth.browserSpec})`);
    return;
  }
  if (auth.mode === 'cookies-file') {
    console.log(`[yt-dlp] Auth mode: cookies file (${auth.cookiesPath})`);
    try {
      if (auth.cookiesPath) {
        const ageMs = Date.now() - fs.statSync(auth.cookiesPath).mtimeMs;
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        if (ageDays >= 7) {
          console.warn(`[yt-dlp] Cookies file is ${ageDays} days old; if bot-checks persist, refresh cookies.`);
        }
      }
    } catch {
      // ignore stat errors
    }
    return;
  }

  console.warn('[yt-dlp] Auth mode: none (set YTDLP_COOKIES_PATH or YTDLP_COOKIES_FROM_BROWSER to avoid bot checks)');
}

export function getYtDlpAuthArgs(): string[] {
  const auth = getAuthConfig();
  if (auth.mode === 'browser' && auth.browserSpec) {
    return ['--cookies-from-browser', auth.browserSpec];
  }
  if (auth.mode === 'cookies-file' && auth.cookiesPath) {
    return ['--cookies', auth.cookiesPath];
  }
  return [];
}

export function withYtDlpAuthFlags<T extends Record<string, unknown>>(flags: T): T {
  const auth = getAuthConfig();
  if (auth.mode === 'browser' && auth.browserSpec) {
    return {
      ...flags,
      cookiesFromBrowser: auth.browserSpec,
    };
  }
  if (auth.mode === 'cookies-file' && auth.cookiesPath) {
    return {
      ...flags,
      cookies: auth.cookiesPath,
    };
  }
  return flags;
}
