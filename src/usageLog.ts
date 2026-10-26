import fs from 'fs/promises';
import path from 'path';

export type UsageLogFields = Record<string, unknown>;

interface LocalTimeParts {
  localDate: string;
  localTime: string;
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const DEFAULT_TIME_ZONE = 'Europe/Helsinki';
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_LENGTH = 100;
const MAX_DEPTH = 6;
const REDACTED_KEY_RE = /(authorization|cookie|password|secret|token)/i;

let writeQueue: Promise<void> = Promise.resolve();
let lastRetentionDay = '';

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  return fallback;
}

function usageLogEnabled(): boolean {
  return envFlag(process.env.USAGE_LOG_ENABLED, true);
}

function usageLogTimeZone(): string {
  return process.env.USAGE_LOG_TIME_ZONE?.trim() || DEFAULT_TIME_ZONE;
}

function usageLogService(): string {
  return process.env.USAGE_LOG_SERVICE?.trim() || 'eppu';
}

function localTimeParts(date: Date, timeZone: string): LocalTimeParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    localDate: `${values.year}-${values.month}-${values.day}`,
    localTime: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function resolveLogPath(localDate: string): string {
  const explicitPath = process.env.USAGE_LOG_PATH?.trim();
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(process.cwd(), explicitPath);
  }

  const explicitDir = process.env.USAGE_LOG_DIR?.trim();
  const logDir = explicitDir
    ? (path.isAbsolute(explicitDir) ? explicitDir : path.resolve(process.cwd(), explicitDir))
    : DEFAULT_LOG_DIR;
  return path.join(logDir, `usage-${localDate}.jsonl`);
}

export function sanitizeUrlForUsageLog(value: string): string {
  if (!/^https?:\/\//i.test(value)) {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }

  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';

    const host = parsed.hostname.toLowerCase();
    const isYouTube = host === 'youtu.be'
      || host === 'youtube.com'
      || host.endsWith('.youtube.com')
      || host === 'music.youtube.com';

    if (isYouTube) {
      const keep = new URLSearchParams();
      for (const key of ['v', 'list', 't', 'start', 'index']) {
        const param = parsed.searchParams.get(key);
        if (param) keep.set(key, param);
      }
      parsed.search = keep.toString();
    } else {
      parsed.search = '';
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }
}

function sanitizeValue(value: unknown, depth = 0, key = ''): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const sanitized = /url$/i.test(key) ? sanitizeUrlForUsageLog(value) : value;
    return sanitized.length > MAX_STRING_LENGTH
      ? `${sanitized.slice(0, MAX_STRING_LENGTH)}...`
      : sanitized;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (depth >= MAX_DEPTH) {
    return '[max-depth]';
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map(item => sanitizeValue(item, depth + 1))
      .filter(item => item !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEY_RE.test(entryKey)) {
        out[entryKey] = '[redacted]';
        continue;
      }
      const sanitized = sanitizeValue(entryValue, depth + 1, entryKey);
      if (sanitized !== undefined) {
        out[entryKey] = sanitized;
      }
    }
    return out;
  }
  return String(value);
}

async function pruneDailyLogs(filePath: string, localDate: string): Promise<void> {
  // Explicit single-file logs are owned by the caller's rotation policy.
  if (process.env.USAGE_LOG_PATH?.trim() || lastRetentionDay === localDate) return;
  lastRetentionDay = localDate;
  const configured = Number(process.env.USAGE_LOG_RETENTION_DAYS ?? '30');
  const days = Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 30;
  if (!days) return;
  const cutoff = new Date(Date.parse(`${localDate}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const directory = path.dirname(filePath);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const date = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry.name)?.[1];
      if (entry.isFile() && date && date < cutoff) await fs.unlink(path.join(directory, entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[usage-log] retention failed:', error);
  }
}

async function appendLine(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, 'utf8');
}

export function logUsage(event: string, fields: UsageLogFields = {}): void {
  if (!usageLogEnabled()) return;

  const now = new Date();
  const timeZone = usageLogTimeZone();
  const { localDate, localTime } = localTimeParts(now, timeZone);
  const entry = sanitizeValue({
    ts: now.toISOString(),
    service: usageLogService(),
    event,
    timeZone,
    localDate,
    localTime,
    localTimestamp: `${localDate} ${localTime}`,
    ...fields,
  }) as Record<string, unknown>;

  const line = `${JSON.stringify(entry)}\n`;
  const filePath = resolveLogPath(localDate);

  writeQueue = writeQueue
    .then(async () => {
      await pruneDailyLogs(filePath, localDate);
      await appendLine(filePath, line);
    })
    .catch((error) => {
      console.warn('[usage-log] failed to write usage event:', error);
    });
}

export async function flushUsageLog(): Promise<void> {
  await writeQueue;
}
