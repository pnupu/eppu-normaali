import { expect, test } from 'bun:test';
import { classifyInput, extractYouTubeVideoId, ytDlpStreamInput } from './sources';

test('classifies inputs by source', () => {
  expect(classifyInput('elastinen naurava kulkuri')).toEqual({ kind: 'search', query: 'elastinen naurava kulkuri' });
  expect(classifyInput('https://youtu.be/WfzYXN_MuwI').kind).toBe('youtube');
  expect(classifyInput('https://music.youtube.com/watch?v=WfzYXN_MuwI').kind).toBe('youtube');
  expect(classifyInput('https://on.soundcloud.com/abc123').kind).toBe('soundcloud');
  expect(classifyInput('https://m.soundcloud.com/darude/sandstorm-radio-edit').kind).toBe('soundcloud');
  expect(classifyInput('https://open.spotify.com/intl-fi/album/4LH4d3cOWNNsVw41Gqt2kv?si=x'))
    .toEqual({ kind: 'spotify', type: 'album', id: '4LH4d3cOWNNsVw41Gqt2kv' });
  expect(classifyInput('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'))
    .toEqual({ kind: 'spotify', type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  expect(classifyInput('https://example.com/song.mp3').kind).toBe('unsupported');
});

test('extracts YouTube video ids from every link shape', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=WfzYXN_MuwI&list=RDSqMRyyL958w&index=5',
    'https://youtu.be/WfzYXN_MuwI?t=10',
    'https://www.youtube.com/shorts/WfzYXN_MuwI',
    'https://www.youtube.com/live/WfzYXN_MuwI',
  ]) {
    expect(extractYouTubeVideoId(url)).toBe('WfzYXN_MuwI');
  }
  expect(extractYouTubeVideoId('https://www.youtube.com/playlist?list=PL123')).toBeNull();
});

test('Spotify tracks stream from a YouTube Music search', () => {
  const args = ytDlpStreamInput({ source: 'spotify', title: 'Pink Floyd - Time', url: 'https://open.spotify.com/track/x' });
  expect(args).toEqual(['--playlist-items', '1', 'https://music.youtube.com/search?q=Pink%20Floyd%20-%20Time#songs']);
});


test('SoundCloud stream inputs cannot concatenate a set into one queue item', () => {
  expect(ytDlpStreamInput({ source: 'soundcloud', title: 'Set', url: 'https://soundcloud.com/u/sets/s' }))
    .toEqual(['--no-playlist', '--playlist-items', '1', 'https://soundcloud.com/u/sets/s']);
});

test('oEmbed failures fall back to yt-dlp while successful metadata stays on the fast path', async () => {
  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eppu-resolver-test-'));
  try {
    const executable = path.join(directory, 'yt-dlp');
    const argumentsFile = path.join(directory, 'arguments');
    await fs.writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$EPPU_TEST_ARGS"
case " $* " in
  *" --yes-playlist "*)
    printf '%s\\n' '{"title":"Public playlist","entries":[{"id":"MeJVWBSsPAY","title":"[Private video]"},{"id":"WfzYXN_MuwI","title":"Public song"}]}'
    exit 0
    ;;
esac
if [ -n "$EPPU_TEST_FAILURE" ]; then
  printf '%s\\n' "$EPPU_TEST_FAILURE" >&2
  exit 1
fi
printf '%s\\n' '{"id":"MeJVWBSsPAY","title":"Fallback title","duration":180}'
`, { mode: 0o755 });
    const modulePath = path.join(import.meta.dir, 'sources.ts');
    const script = `
      const {resolveInput, ResolveError} = await import(${JSON.stringify(modulePath)});
      const results = [];
      for (const status of [401, 503, 'network', 200]) {
        globalThis.fetch = async () => {
          if (status === 'network') throw new Error('offline');
          return new Response(JSON.stringify({title:'Fast title'}), {status});
        };
        const resolved = await resolveInput('https://www.youtube.com/watch?v=MeJVWBSsPAY');
        results.push(resolved.tracks[0].title);
      }
      for (const detail of ['ERROR: Private video', 'ERROR: Video unavailable', 'ERROR: network temporarily unavailable']) {
        process.env.EPPU_TEST_FAILURE = detail;
        globalThis.fetch = async () => new Response(null, {status:401});
        try {
          await resolveInput('https://www.youtube.com/watch?v=MeJVWBSsPAY');
          throw new Error('expected extraction failure');
        } catch(error) {
          results.push({resolveError:error instanceof ResolveError});
        }
      }
      process.env.EPPU_TEST_FAILURE = 'ERROR: Private video';
      const playlist = await resolveInput('https://www.youtube.com/watch?v=MeJVWBSsPAY&list=PLTEST');
      results.push({name:playlist.name,keys:playlist.tracks.map(track=>track.key),skipped:playlist.skipped});
      console.log('RESULT:' + JSON.stringify(results));
    `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, YTDLP_BIN: executable, EPPU_TEST_ARGS: argumentsFile },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, errors: code ? errors : '' }).toEqual({ code: 0, errors: '' });
    expect(JSON.parse(output.split('RESULT:')[1].trim())).toEqual([
      'Fallback title', 'Fallback title', 'Fallback title', 'Fast title',
      {resolveError:true}, {resolveError:true}, {resolveError:false},
      {name:'Public playlist',keys:['WfzYXN_MuwI'],skipped:1},
    ]);
    const args = await fs.readFile(argumentsFile, 'utf8');
    expect(args).toContain('--no-playlist');
    expect(args).toContain('https://www.youtube.com/watch?v=MeJVWBSsPAY');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
