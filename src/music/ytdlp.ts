// src/music/ytdlp.ts
// Shared yt-dlp runtime: binary path, cookie handling, JSON extraction with auto cookie refresh.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Flags, create as createYoutubeDl } from 'youtube-dl-exec';

export const YTDLP_BIN = process.env.YTDLP_BIN?.trim() || path.join(__dirname, '../../node_modules/youtube-dl-exec/bin/yt-dlp');
const youtubeDl = createYoutubeDl(YTDLP_BIN);
const DEFAULT_COOKIES_PATH = path.join(__dirname, '../../cookies.txt');
export function formatYtDlpError(error: unknown): string {
  const err = error as { message?: string; stderr?: string; stdout?: string; exitCode?: number } | null;
  if (!err) return 'unknown error';
  const parts: string[] = [];
  if (typeof err.exitCode === 'number') parts.push(`exitCode=${err.exitCode}`);
  if (err.message) parts.push(`message=${String(err.message).trim()}`);
  if (err.stderr) parts.push(`stderr=${String(err.stderr).trim()}`);
  if (err.stdout) parts.push(`stdout=${String(err.stdout).trim()}`);
  return parts.join(' | ') || 'unknown error';
}
interface YtDlpRuntimeOptions {
  jsRuntimes: string;
  cookiesFilePath: string;
  cookiesFile: string | null;
  cookiesFromBrowser: string | null;
  cookieSource: 'file' | 'browser' | 'none';
}
let runtimeOptionsLogged = false;
function getYtDlpRuntimeOptions(): YtDlpRuntimeOptions {
  const jsRuntimes = process.env.YTDLP_JS_RUNTIMES?.trim() || 'node';
  const cookiesFromBrowserRaw = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  const cookiesFromBrowser = cookiesFromBrowserRaw && cookiesFromBrowserRaw.length > 0
    ? cookiesFromBrowserRaw
    : null;
  const configuredCookiesPath = process.env.YTDLP_COOKIES_FILE?.trim();
  const cookiesPathCandidate = configuredCookiesPath && configuredCookiesPath.length > 0
    ? configuredCookiesPath
    : DEFAULT_COOKIES_PATH;
  const cookiesFile = fs.existsSync(cookiesPathCandidate) ? cookiesPathCandidate : null;
  const cookieSource: YtDlpRuntimeOptions['cookieSource'] = cookiesFile
    ? 'file'
    : (cookiesFromBrowser ? 'browser' : 'none');

  if (!runtimeOptionsLogged) {
    runtimeOptionsLogged = true;
    const cookiesMode = cookieSource === 'file'
      ? `file:${cookiesFile}`
      : (cookieSource === 'browser' ? `browser:${cookiesFromBrowser}` : 'none');
    console.log(`[yt-dlp] runtime js-runtimes=${jsRuntimes} cookies=${cookiesMode}`);
    if (!cookiesFromBrowser && configuredCookiesPath && !cookiesFile) {
      console.warn(`[yt-dlp] Configured cookies file not found: ${configuredCookiesPath}`);
    }
    if (cookiesFile && cookiesFromBrowser) {
      console.log('[yt-dlp] Both cookie file and browser cookies configured; preferring cookies file.');
    }
  }

  return {
    jsRuntimes,
    cookiesFilePath: cookiesPathCandidate,
    cookiesFile,
    cookiesFromBrowser,
    cookieSource,
  };
}
type YtCookieSourceOverride = 'default' | 'file' | 'browser';
function resolveCookieSource(
  runtime: YtDlpRuntimeOptions,
  override: YtCookieSourceOverride = 'default'
): YtDlpRuntimeOptions['cookieSource'] {
  if (override === 'file') {
    return runtime.cookiesFile ? 'file' : 'none';
  }
  if (override === 'browser') {
    return runtime.cookiesFromBrowser ? 'browser' : 'none';
  }
  return runtime.cookieSource;
}
export function buildYtDlpFlags(base: Flags, overrideCookieSource: YtCookieSourceOverride = 'default'): Flags {
  const runtime = getYtDlpRuntimeOptions();
  const merged = { ...base } as Flags & { cookiesFromBrowser?: string };
  merged.jsRuntimes = runtime.jsRuntimes as Flags['jsRuntimes'];
  const cookieSource = resolveCookieSource(runtime, overrideCookieSource);
  if (cookieSource === 'file' && runtime.cookiesFile) {
    merged.cookies = runtime.cookiesFile;
  } else if (cookieSource === 'browser' && runtime.cookiesFromBrowser) {
    merged.cookiesFromBrowser = runtime.cookiesFromBrowser;
  }
  return merged;
}
export function buildYtDlpSpawnArgs(baseArgs: string[], overrideCookieSource: YtCookieSourceOverride = 'default'): string[] {
  const runtime = getYtDlpRuntimeOptions();
  const args = [...baseArgs, '--js-runtimes', runtime.jsRuntimes];
  const cookieSource = resolveCookieSource(runtime, overrideCookieSource);
  if (cookieSource === 'file' && runtime.cookiesFile) {
    args.push('--cookies', runtime.cookiesFile);
  } else if (cookieSource === 'browser' && runtime.cookiesFromBrowser) {
    args.push('--cookies-from-browser', runtime.cookiesFromBrowser);
  }
  return args;
}
export function isYtCookieAuthErrorText(text: string): boolean {
  const value = text.toLowerCase();
  return value.includes('sign in to confirm you')
    || value.includes("sign in to confirm you're not a bot")
    || value.includes('sign in to confirm you\u2019re not a bot')
    || value.includes('use --cookies-from-browser or --cookies for the authentication');
}
export function isYtExtractionChallengeErrorText(text: string): boolean {
  const value = text.toLowerCase();
  return value.includes('n challenge solving failed')
    || value.includes('signature solving failed')
    || value.includes('js challenge provider')
    || value.includes('only images are available')
    || value.includes('requested format is not available')
    || value.includes('some formats may be missing');
}
function isYouTubeUrlLike(input: string): boolean {
  const value = input.toLowerCase();
  return value.includes('youtube.com/') || value.includes('youtu.be/');
}
function normalizeAndroidFallbackFormat(format?: string): string | null {
  if (!format) return null;
  const trimmed = format.trim();
  if (!trimmed) return null;
  if (trimmed.includes('bestaudio')) {
    return '18/best';
  }
  return trimmed;
}
function buildAndroidFallbackJsonArgs(input: string, baseFlags: Flags): string[] {
  const args: string[] = [
    '--extractor-args', 'youtube:player_client=android',
    '--no-warnings',
    '--no-progress',
  ];
  if (baseFlags.dumpSingleJson) args.push('--dump-single-json');
  if (baseFlags.simulate) args.push('--simulate');
  if (baseFlags.flatPlaylist) args.push('--flat-playlist');
  if (baseFlags.yesPlaylist) args.push('--yes-playlist');
  if (typeof baseFlags.playlistEnd === 'number') args.push('--playlist-end', String(baseFlags.playlistEnd));
  const fallbackFormat = normalizeAndroidFallbackFormat(typeof baseFlags.format === 'string' ? baseFlags.format : undefined);
  if (fallbackFormat) {
    args.push('-f', fallbackFormat);
  }
  args.push(input);
  return args;
}
async function runYtDlpJsonViaSpawn<T>(args: string[], context: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    proc.on('error', (error) => {
      reject(error);
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject({
          exitCode: code,
          message: `yt-dlp spawn failed in ${context}`,
          stderr: stderr.trim() || undefined,
          stdout: stdout.trim() || undefined,
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject({
          message: `yt-dlp JSON parse failed in ${context}: ${(error as Error).message}`,
          stderr: stderr.trim() || undefined,
          stdout: stdout.trim() || undefined,
        });
      }
    });
  });
}
function isYtCookieAuthError(error: unknown): boolean {
  const text = formatYtDlpError(error);
  return isYtCookieAuthErrorText(text);
}
let cookieRefreshPromise: Promise<boolean> | null = null;
export async function refreshYtCookiesFromBrowser(reason: string, urlForRefresh?: string): Promise<boolean> {
  const runtime = getYtDlpRuntimeOptions();
  const browserProfile = runtime.cookiesFromBrowser;
  if (!browserProfile) {
    console.warn(`[yt-cookie] Skipping refresh (${reason}): YTDLP_COOKIES_FROM_BROWSER not configured`);
    return false;
  }
  if (cookieRefreshPromise) {
    console.log(`[yt-cookie] Refresh already in progress, waiting (reason=${reason})`);
    return cookieRefreshPromise;
  }
  cookieRefreshPromise = new Promise<boolean>((resolve) => {
    try {
      fs.mkdirSync(path.dirname(runtime.cookiesFilePath), { recursive: true });
    } catch (error) {
      console.error(`[yt-cookie] Failed to prepare cookie dir for ${runtime.cookiesFilePath}:`, error);
    }
    const refreshUrl = (urlForRefresh && /^https?:\/\//.test(urlForRefresh))
      ? urlForRefresh
      : (process.env.YTDLP_COOKIE_REFRESH_URL?.trim() || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const args = [
      '--simulate',
      '--no-warnings',
      '--no-progress',
      '--cookies-from-browser', browserProfile,
      '--cookies', runtime.cookiesFilePath,
      '--js-runtimes', runtime.jsRuntimes,
      refreshUrl,
    ];
    console.warn(
      `[yt-cookie] Refreshing cookies reason=${reason} browser=${browserProfile} `
      + `target=${runtime.cookiesFilePath} url=${refreshUrl}`
    );
    const refreshProc = spawn(YTDLP_BIN, args);
    let stderr = '';
    refreshProc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    refreshProc.on('error', (error: Error) => {
      console.error('[yt-cookie] Cookie refresh process error:', error);
      resolve(false);
    });
    refreshProc.on('exit', (code: number | null) => {
      const wroteFile = fs.existsSync(runtime.cookiesFilePath) && fs.statSync(runtime.cookiesFilePath).size > 0;
      const ok = code === 0 && wroteFile;
      if (ok) {
        console.log(`[yt-cookie] Cookie refresh succeeded, wrote ${runtime.cookiesFilePath}`);
      } else {
        const trimmed = stderr.trim();
        console.error(
          `[yt-cookie] Cookie refresh failed code=${code ?? 'null'} `
          + `${trimmed ? `stderr=${trimmed}` : ''}`
        );
      }
      resolve(ok);
    });
  }).finally(() => {
    cookieRefreshPromise = null;
  });
  return cookieRefreshPromise;
}
export async function runYtDlpJsonWithAutoCookieRefresh<T>(
  input: string,
  baseFlags: Flags,
  context: string
): Promise<T> {
  let lastError: unknown;
  try {
    return await youtubeDl(input, buildYtDlpFlags(baseFlags)) as unknown as T;
  } catch (error) {
    lastError = error;
    const runtime = getYtDlpRuntimeOptions();
    const formattedError = formatYtDlpError(error);
    const shouldRefreshCookies = runtime.cookiesFromBrowser
      && (isYtCookieAuthError(error) || isYtExtractionChallengeErrorText(formattedError));
    if (shouldRefreshCookies) {
      console.warn(`[yt-cookie] Refresh-triggering extraction error in ${context}, refreshing cookies and retrying once`);
      const refreshed = await refreshYtCookiesFromBrowser(`extractor-error:${context}`, input);
      if (refreshed) {
        try {
          return await youtubeDl(input, buildYtDlpFlags(baseFlags, 'file')) as unknown as T;
        } catch (retryError) {
          lastError = retryError;
          if (isYtCookieAuthError(retryError) && runtime.cookiesFromBrowser) {
            console.warn(`[yt-cookie] File retry failed in ${context}, retrying once with browser cookies`);
            try {
              return await youtubeDl(input, buildYtDlpFlags(baseFlags, 'browser')) as unknown as T;
            } catch (browserRetryError) {
              lastError = browserRetryError;
            }
          }
        }
      }
    }
  }
  if (isYouTubeUrlLike(input) && isYtExtractionChallengeErrorText(formatYtDlpError(lastError))) {
    console.warn(`[yt-dlp] ${context} retrying with android no-cookie fallback`);
    return await runYtDlpJsonViaSpawn<T>(buildAndroidFallbackJsonArgs(input, baseFlags), `${context} android-fallback`);
  }
  throw lastError;
}

/**
 * Run yt-dlp with the configured runtime/cookies and parse its JSON output.
 * With allowPartial, a non-zero exit still resolves when stdout holds valid JSON
 * (yt-dlp --ignore-errors exits 1 when some playlist entries fail).
 */
export function runYtDlpJson<T>(args: string[], context: string, options: { allowPartial?: boolean } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, buildYtDlpSpawnArgs(['--no-warnings', '--no-progress', ...args]));
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      let parsed: T | null = null;
      try {
        parsed = JSON.parse(stdout) as T;
      } catch {
        parsed = null;
      }
      if (parsed && (code === 0 || options.allowPartial)) {
        if (code !== 0) console.warn(`[yt-dlp] ${context} finished with exit ${code}; using partial result`);
        resolve(parsed);
        return;
      }
      reject({ exitCode: code, message: `yt-dlp failed in ${context}`, stderr: stderr.trim() || undefined });
    });
  });
}
