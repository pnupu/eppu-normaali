import { expect, test } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { flushUsageLog, logUsage } from './usageLog';

test('daily retention removes only old daily logs and redacts sensitive fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eppu-logs-test-'));
  const keys = ['USAGE_LOG_DIR', 'USAGE_LOG_PATH', 'USAGE_LOG_ENABLED', 'USAGE_LOG_RETENTION_DAYS', 'USAGE_LOG_TIME_ZONE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.USAGE_LOG_DIR = directory;
    delete process.env.USAGE_LOG_PATH;
    process.env.USAGE_LOG_ENABLED = 'true';
    process.env.USAGE_LOG_RETENTION_DAYS = '30';
    process.env.USAGE_LOG_TIME_ZONE = 'UTC';
    await fs.writeFile(path.join(directory, 'usage-2000-01-01.jsonl'), 'old');
    await fs.writeFile(path.join(directory, 'keep.jsonl'), 'keep');
    logUsage('retention.test', { token: 'private', trackUrl: 'https://example.com/track?secret=private' });
    await flushUsageLog();
    const names = await fs.readdir(directory);
    expect(names).not.toContain('usage-2000-01-01.jsonl');
    expect(names).toContain('keep.jsonl');
    const entry = JSON.parse(await fs.readFile(path.join(directory, `usage-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8'));
    expect(entry.token).toBe('[redacted]');
    expect(entry.trackUrl).toBe('https://example.com/track');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
