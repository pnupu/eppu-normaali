import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stopVoiceWorker, transcribeLocal } from './voiceWorker';

const saved = { python: process.env.VOICE_PYTHON, script: process.env.VOICE_WORKER_SCRIPT };
const temporaryDirectories: string[] = [];
afterEach(() => {
  stopVoiceWorker();
  for (const [key, value] of Object.entries({ VOICE_PYTHON: saved.python, VOICE_WORKER_SCRIPT: saved.script })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('a failed spawn rejects promptly and a repaired worker can serve the next request', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eppu-worker-test-'));
  temporaryDirectories.push(directory);
  process.env.VOICE_PYTHON = path.join(directory, 'missing-python');
  const failed = transcribeLocal('unused.wav', 'fi', '');
  await expect(failed).rejects.toThrow(/ENOENT|not running/);

  const script = path.join(directory, 'worker.js');
  fs.writeFileSync(script, `
    require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      console.log(JSON.stringify({ id: request.id, ok: true, text: 'recovered' }));
    });
  `);
  process.env.VOICE_PYTHON = process.execPath;
  process.env.VOICE_WORKER_SCRIPT = script;
  expect(await transcribeLocal('unused.wav', 'fi', '')).toBe('recovered');
}, 5000);
