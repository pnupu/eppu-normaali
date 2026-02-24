import path from 'path';
import { spawn } from 'child_process';
import { Readable, PassThrough } from 'stream';
import { PrimeHooks } from './play-types';
import { getYtDlpAuthArgs, logYtDlpAuthContext } from './ytdlp-auth';

const YTDLP_BIN = path.join(__dirname, '../../node_modules/youtube-dl-exec/bin/yt-dlp');

export function inlineVolumeEnabled(): boolean {
  const value = process.env.AUDIO_INLINE_VOLUME?.trim().toLowerCase();
  if (!value) return false;
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

export function isExpectedStreamTeardownError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  if (!err) return false;
  const code = err.code || '';
  const message = (err.message || '').toLowerCase();
  return code === 'ERR_STREAM_PREMATURE_CLOSE'
    || code === 'EPIPE'
    || message.includes('premature close')
    || message.includes('aborted');
}

export function logStreamIssue(context: string, error: unknown): void {
  if (isExpectedStreamTeardownError(error)) {
    const code = (error as { code?: string } | null)?.code || 'n/a';
    console.log(`${context} (expected teardown: ${code})`);
    return;
  }
  console.error(context, error);
}

function ytdlpVerboseLogsEnabled(): boolean {
  const value = process.env.YTDLP_VERBOSE_LOGS?.trim().toLowerCase();
  if (!value) return false;
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

function playbackPrimeBytes(): number {
  const raw = Number.parseInt(process.env.PLAYBACK_PRIME_BYTES || '192000', 10);
  if (!Number.isFinite(raw)) return 192000;
  return Math.max(96000, raw);
}

function playbackPrimeTimeoutMs(): number {
  const raw = Number.parseInt(process.env.PLAYBACK_PRIME_TIMEOUT_MS || '1800', 10);
  if (!Number.isFinite(raw)) return 1800;
  return Math.max(0, raw);
}

export async function primePcmStream(source: Readable, label: string, hooks?: PrimeHooks): Promise<Readable> {
  const targetBytes = playbackPrimeBytes();
  if (targetBytes <= 0) {
    return source;
  }

  const timeoutMs = playbackPrimeTimeoutMs();
  const output = new PassThrough();

  return new Promise((resolve) => {
    let primed = false;
    let bufferedBytes = 0;
    const buffers: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let zeroByteTimeoutAttempts = 0;

    const cleanup = () => {
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
      source.removeListener('error', onError);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const flushAndPipe = (reason: 'bytes' | 'timeout' | 'eof') => {
      if (primed) return;
      primed = true;
      source.pause();
      cleanup();
      for (const chunk of buffers) {
        output.write(chunk);
      }
      source.pipe(output);
      source.resume();
      hooks?.onPrimed?.(bufferedBytes, reason);
      resolve(output);
    };

    const armPrimeTimer = () => {
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => {
        if (primed) return;
        if (bufferedBytes === 0) {
          zeroByteTimeoutAttempts += 1;
          console.log(
            `[playback] Prime timeout reached for ${label} with 0 bytes `
            + `(attempt ${zeroByteTimeoutAttempts}), waiting for first audio bytes`
          );
          timer = null;
          armPrimeTimer();
          return;
        }

        console.log(`[playback] Prime timeout reached for ${label}, starting with ${bufferedBytes} bytes`);
        flushAndPipe('timeout');
      }, timeoutMs);
    };

    const onData = (chunk: Buffer | string) => {
      if (primed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bufferedBytes === 0) {
        hooks?.onFirstChunk?.(buf.length);
      }
      buffers.push(buf);
      bufferedBytes += buf.length;
      if (bufferedBytes >= targetBytes) {
        flushAndPipe('bytes');
      }
    };

    const onEnd = () => {
      if (primed) return;
      primed = true;
      cleanup();
      for (const chunk of buffers) {
        output.write(chunk);
      }
      hooks?.onPrimed?.(bufferedBytes, 'eof');
      output.end();
      resolve(output);
    };

    const onError = (error: Error) => {
      if (!primed) {
        primed = true;
        cleanup();
        output.destroy(error);
        resolve(output);
        return;
      }
      output.destroy(error);
    };

    source.on('data', onData);
    source.on('end', onEnd);
    source.on('error', onError);

    armPrimeTimer();
  });
}

export function createFfmpegStream(url: string): Readable {
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-headers', 'Accept: */*',
    '-headers', 'Accept-Language: en-US,en;q=0.9',
    '-headers', 'Accept-Encoding: identity',
    '-headers', 'Range: bytes=0-',
    '-headers', 'Connection: keep-alive',
    '-headers', 'Sec-Fetch-Dest: video',
    '-headers', 'Sec-Fetch-Mode: no-cors',
    '-headers', 'Sec-Fetch-Site: cross-site',
    '-i', url,
    '-analyzeduration', '0',
    '-probesize', '32768',
    '-loglevel', 'info',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-acodec', 'pcm_s16le',
    '-bufsize', '64k',
    'pipe:1'
  ]);

  ffmpeg.on('error', error => {
    console.error('FFmpeg process error:', error);
  });

  ffmpeg.on('exit', (code, signal) => {
    if (code !== 0) {
      console.log(`FFmpeg process exited with code ${code} and signal ${signal}`);
    } else {
      console.log('FFmpeg process completed successfully');
    }
  });

  ffmpeg.stderr.on('data', (data) => {
    const errorMessage = data.toString();
    console.error('FFmpeg stderr:', errorMessage);

    if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
      console.error('FFmpeg: Access forbidden - URL may have expired');
    }
    if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
      console.error('FFmpeg: URL not found - URL may have expired');
    }
  });

  const stdout = ffmpeg.stdout;
  stdout.on('error', error => {
    console.error('FFmpeg stdout error:', error);
  });

  return stdout;
}

export function createYouTubeStream(youtubeUrl: string): Readable {
  console.log('Piping yt-dlp -> ffmpeg for:', youtubeUrl);
  logYtDlpAuthContext();

  const ytdlp = spawn(YTDLP_BIN, [
    '-f', 'bestaudio',
    '-o', '-',
    '--quiet',
    '--no-warnings',
    '--no-progress',
    ...getYtDlpAuthArgs(),
    youtubeUrl
  ]);

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-analyzeduration', '0',
    '-probesize', '32768',
    '-loglevel', 'error',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-acodec', 'pcm_s16le',
    '-bufsize', '64k',
    'pipe:1'
  ]);

  ytdlp.stdout.pipe(ffmpeg.stdin, { end: true });

  ffmpeg.stdin.on('error', (error) => {
    logStreamIssue('FFmpeg stdin error', error);
  });

  let ytdlpExited = false;

  ytdlp.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;
    const lowered = line.toLowerCase();
    if (ytdlpVerboseLogsEnabled()) {
      console.log('yt-dlp:', line);
      return;
    }
    if (lowered.includes('error') || lowered.includes('warning')) {
      console.warn('yt-dlp:', line);
    }
  });

  ytdlp.on('error', error => {
    console.error('yt-dlp process error:', error);
  });

  ytdlp.on('exit', (code) => {
    ytdlpExited = true;
    if (code !== 0) console.log(`yt-dlp exited with code ${code}`);
  });

  ffmpeg.on('error', error => {
    console.error('FFmpeg process error:', error);
  });

  ffmpeg.on('exit', (code) => {
    if (code !== 0) console.log(`FFmpeg exited with code ${code}`);
    else console.log('FFmpeg completed successfully');
  });

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('403') || msg.includes('Forbidden')) {
      console.error('FFmpeg: Access forbidden');
    }
    if (msg.toLowerCase().includes('error')) {
      console.error('FFmpeg stderr:', msg.trim());
    }
  });

  ffmpeg.stdout.on('error', error => {
    logStreamIssue('FFmpeg stdout error', error);
  });

  ffmpeg.on('exit', () => {
    if (!ytdlpExited && ytdlp.exitCode === null) {
      ytdlp.kill();
    }
  });

  const passthrough = new PassThrough();
  ffmpeg.stdout.pipe(passthrough);

  return passthrough;
}

export function createPrefetchedFileStream(filePath: string, onCleanup: (filePath: string) => void): Readable {
  const ffmpeg = spawn('ffmpeg', [
    '-re',
    '-i', filePath,
    '-analyzeduration', '0',
    '-probesize', '32768',
    '-loglevel', 'error',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-acodec', 'pcm_s16le',
    '-bufsize', '64k',
    'pipe:1'
  ]);

  ffmpeg.on('error', error => {
    console.error('[prefetch] FFmpeg process error for prefetched file:', error);
  });

  ffmpeg.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[prefetch] FFmpeg exited with code ${code} for prefetched file ${path.basename(filePath)}`);
    }
    onCleanup(filePath);
  });

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error('[prefetch] FFmpeg stderr:', msg);
  });

  const passthrough = new PassThrough();
  ffmpeg.stdout.pipe(passthrough);
  return passthrough;
}
