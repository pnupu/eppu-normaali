import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import path from 'path';

export interface WakeResult {
  detected: boolean;
  score: number;
  model: string | null;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function envBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const RESTART_DELAY_MS = 5000;

class VoiceWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = '';
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private buildArgs(): string[] {
    const script = process.env.VOICE_WORKER_SCRIPT?.trim()
      || path.join(process.cwd(), 'scripts', 'voice_worker.py');
    const args = [script];

    const owwModel = process.env.OPENWAKEWORD_MODEL_PATH?.trim();
    if (owwModel) args.push('--oww-model', path.resolve(owwModel));
    const verifier = process.env.OPENWAKEWORD_VERIFIER_PATH?.trim();
    if (verifier) args.push('--oww-verifier', path.resolve(verifier));
    const verifierThreshold = process.env.OPENWAKEWORD_VERIFIER_THRESHOLD?.trim();
    if (verifierThreshold) args.push('--oww-verifier-threshold', verifierThreshold);

    args.push('--whisper-model', process.env.VOICE_WHISPER_MODEL?.trim() || 'base');
    args.push('--whisper-device', process.env.VOICE_WHISPER_DEVICE?.trim() || 'cpu');
    args.push('--whisper-compute', process.env.VOICE_WHISPER_COMPUTE?.trim() || 'int8');
    const downloadRoot = process.env.VOICE_WHISPER_DOWNLOAD_ROOT?.trim();
    if (downloadRoot) args.push('--whisper-download-root', path.resolve(downloadRoot));
    if (envBool(process.env.VOICE_WHISPER_PRELOAD, false)) args.push('--preload-whisper');

    return args;
  }

  private ensureStarted(): void {
    if (this.proc || this.stopped) return;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const python = process.env.VOICE_PYTHON?.trim()
      || process.env.OPENWAKEWORD_PYTHON?.trim()
      || 'python3';
    const args = this.buildArgs();
    const proc = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.stdoutBuffer = '';
    console.log(`[voice-worker] started pid=${proc.pid} python=${python}`);

    proc.stdout.on('data', (chunk: Buffer) => { if (this.proc === proc) this.onStdout(chunk); });
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      if (envBool(process.env.VOICE_DEBUG, false)) {
        console.log(`[voice-worker] ${text}`);
      }
    });
    const failProcess = (error: Error) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.failAllPending(error);
      proc.kill();
      if (!this.stopped && !this.restartTimer) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.ensureStarted();
        }, RESTART_DELAY_MS);
      }
    };
    proc.stdin.on('error', (error) => failProcess(error));
    proc.on('error', (error) => {
      console.error('[voice-worker] spawn error:', error);
      failProcess(error);
    });
    proc.on('exit', (code, signal) => {
      console.error(`[voice-worker] exited code=${code ?? '-'} signal=${signal ?? '-'}`);
      failProcess(new Error('Voice worker exited'));
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (!line) continue;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        console.error(`[voice-worker] unparseable output: ${line.slice(0, 200)}`);
        continue;
      }

      const id = typeof message.id === 'number' ? message.id : null;
      if (id === 0 && message.event === 'ready') {
        console.log(`[voice-worker] ready wake=${message.wake === true}`);
        continue;
      }
      if (id === null) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.ok === true) {
        pending.resolve(message);
      } else {
        pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Voice worker error'));
      }
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    this.ensureStarted();
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) {
      return Promise.reject(new Error('Voice worker is not running'));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Voice worker request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n', (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(error);
          }
        }
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.failAllPending(new Error('Voice worker stopped'));
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

let worker: VoiceWorker | null = null;

function getWorker(): VoiceWorker {
  if (!worker) worker = new VoiceWorker();
  return worker;
}

export function startVoiceWorker(): void {
  getWorker().request({ op: 'ping' }, 120_000).catch((error) => {
    console.error('[voice-worker] startup ping failed:', error);
  });
}

export function stopVoiceWorker(): void {
  if (worker) worker.stop();
  worker = null;
}

export async function wakeScore(audioPath: string, threshold: number): Promise<WakeResult> {
  const response = await getWorker().request({ op: 'wake', path: audioPath, threshold }, 30_000);
  return {
    detected: response.detected === true,
    score: typeof response.score === 'number' ? response.score : 0,
    model: typeof response.model === 'string' ? response.model : null,
  };
}

export async function transcribeLocal(
  audioPath: string,
  language: string,
  initialPrompt: string
): Promise<string> {
  // First transcription may also trigger the one-time whisper model load/download.
  const response = await getWorker().request({
    op: 'transcribe',
    path: audioPath,
    language,
    initialPrompt,
  }, 300_000);
  return typeof response.text === 'string' ? response.text.trim() : '';
}
