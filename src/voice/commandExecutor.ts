import { Client } from 'discord.js';
import Fuse from 'fuse.js';
import { enqueueFromWeb, queues } from '../commands/play';

export const DEFAULT_VOICE_KEYWORDS: Record<string, string> = Object.freeze({
  '22': 'https://www.youtube.com/watch?v=zI7WGJFKfsE',
});

export type VoiceCommandIntent = 'play' | 'skip' | 'pause' | 'resume' | 'unknown';

export interface VoiceCommandParseResult {
  intent: VoiceCommandIntent;
  query: string;
}

export interface VoiceCommandResult {
  ok: boolean;
  status: number;
  intent: VoiceCommandIntent;
  message: string;
  queuedTitle?: string;
  resolvedUrl?: string;
  error?: string;
}

export function normalizeVoiceKeyword(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeVoiceTranscript(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:/?&=._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const WAKE_PREFIXES = [
  'hei eppu', 'hey eppu', 'hej eppu', 'heieppu',
  'hei epu', 'hei eppo', 'hei ebu', 'hei ebbu', 'heippa eppu',
];

export interface WakePrefixMatch {
  matched: boolean;
  rest: string;
}

/**
 * Checks whether a normalized transcript starts with (a variant of) the wake
 * phrase "Hei Eppu" and returns the command portion after it. Used both for
 * command parsing and for transcript-based wake detection.
 */
export function matchWakePrefix(normalized: string): WakePrefixMatch {
  for (const prefix of WAKE_PREFIXES) {
    if (normalized === prefix) return { matched: true, rest: '' };
    if (normalized.startsWith(`${prefix} `)) {
      return { matched: true, rest: normalized.slice(prefix.length + 1).trim() };
    }
  }
  return { matched: false, rest: normalized };
}

export function transcriptContainsWakePhrase(transcript: string): boolean {
  return matchWakePrefix(normalizeVoiceTranscript(transcript)).matched;
}

const FI_NUMBER_UNITS: Record<string, number> = {
  nolla: 0,
  yksi: 1, yks: 1,
  kaksi: 2, kaks: 2,
  kolme: 3,
  neljä: 4, nelja: 4,
  viisi: 5, viis: 5,
  kuusi: 6, kuus: 6,
  seitsemän: 7, seitseman: 7, seittemän: 7, seitteman: 7,
  kahdeksan: 8, kaheksan: 8,
  yhdeksän: 9, yhdeksan: 9, yheksän: 9, yheksan: 9,
};

function finnishNumberWordToValue(token: string): number | null {
  if (token in FI_NUMBER_UNITS) return FI_NUMBER_UNITS[token];
  if (token === 'kymmenen' || token === 'kymppi') return 10;
  if (token === 'sata') return 100;

  if (token.endsWith('toista')) {
    const unit = FI_NUMBER_UNITS[token.slice(0, -'toista'.length)];
    if (unit !== undefined && unit >= 1 && unit <= 9) return 10 + unit;
  }

  for (const separator of ['kymmentä', 'kymmenta', 'kyt', 'kytä', 'kyta']) {
    const index = token.indexOf(separator);
    if (index <= 0) continue;
    const tens = FI_NUMBER_UNITS[token.slice(0, index)];
    if (tens === undefined || tens < 2 || tens > 9) continue;
    const remainder = token.slice(index + separator.length);
    if (!remainder) return tens * 10;
    const unit = FI_NUMBER_UNITS[remainder];
    if (unit !== undefined && unit >= 1 && unit <= 9) return tens * 10 + unit;
  }
  return null;
}

/** Converts spoken Finnish number words to digits: "kaksikymmentäkaksi" -> "22". */
export function normalizeFinnishNumbers(text: string): string {
  return text
    .split(' ')
    .map((token) => {
      const value = finnishNumberWordToValue(token);
      return value === null ? token : String(value);
    })
    .join(' ');
}

function fuzzyKeywordLookup(query: string, voiceKeywordMap: Record<string, string>): string | undefined {
  const phrases = Object.keys(voiceKeywordMap);
  if (!phrases.length || !query) return undefined;
  const fuse = new Fuse(phrases, { includeScore: true, threshold: 0.3, ignoreLocation: true });
  const best = fuse.search(query)[0];
  if (best && (best.score ?? 1) <= 0.3) return voiceKeywordMap[best.item];
  return undefined;
}

export function parseVoiceCommand(transcript: string): VoiceCommandParseResult {
  const normalized = normalizeVoiceTranscript(transcript);
  const wakeMatch = matchWakePrefix(normalized);
  const wakeless = wakeMatch.matched
    ? wakeMatch.rest
    : (normalized.startsWith('eppu ') ? normalized.slice(5).trim() : normalized);

  if (/^(ohita|skip|seuraava)\b/.test(wakeless)) {
    return { intent: 'skip', query: '' };
  }
  if (/^(tauko|pause|pysayta|pysäytä)\b/.test(wakeless)) {
    return { intent: 'pause', query: '' };
  }
  if (/^(jatka|resume)\b/.test(wakeless)) {
    return { intent: 'resume', query: '' };
  }

  const playMatch = wakeless.match(/^(soita|toista|hae|etsi|play|search|find)\s+(.+)$/);
  if (playMatch) {
    // Trailing sentence punctuation comes from the transcriber, not the user
    return { intent: 'play', query: playMatch[2].trim().replace(/[.,:;!?]+$/, '').trim() };
  }
  return { intent: 'unknown', query: wakeless };
}

export async function executeVoiceCommand(
  client: Client,
  guildId: string,
  requestedBy: string,
  transcript: string,
  voiceKeywordMap: Record<string, string>
): Promise<VoiceCommandResult> {
  const parsed = parseVoiceCommand(transcript);
  const queue = queues.get(guildId);

  if (parsed.intent === 'skip') {
    if (!queue) {
      return { ok: false, status: 404, intent: parsed.intent, message: 'Jonossa ei ole ohitettavaa.', error: 'No queue' };
    }
    queue.skip();
    return { ok: true, status: 200, intent: parsed.intent, message: 'Ohitettiin nykyinen kappale.' };
  }

  if (parsed.intent === 'pause') {
    if (!queue) {
      return { ok: false, status: 404, intent: parsed.intent, message: 'Jonossa ei ole tauotettavaa.', error: 'No queue' };
    }
    queue.pause();
    return { ok: true, status: 200, intent: parsed.intent, message: 'Tauko päälle.' };
  }

  if (parsed.intent === 'resume') {
    if (!queue) {
      return { ok: false, status: 404, intent: parsed.intent, message: 'Jonossa ei ole jatkettavaa.', error: 'No queue' };
    }
    queue.resume();
    return { ok: true, status: 200, intent: parsed.intent, message: 'Toisto jatkuu.' };
  }

  if (parsed.intent !== 'play' || !parsed.query) {
    return {
      ok: false,
      status: 400,
      intent: parsed.intent,
      message: 'Komentoa ei tunnistettu. Sano esimerkiksi: "Eppu soita 22".',
      error: 'Unknown command',
    };
  }

  const queryKey = normalizeVoiceKeyword(parsed.query);
  const numericQueryKey = normalizeFinnishNumbers(queryKey);
  let resolvedUrl: string | undefined = voiceKeywordMap[queryKey] || voiceKeywordMap[numericQueryKey];
  let resolvedTitle: string | undefined;

  if (!resolvedUrl) {
    resolvedUrl = fuzzyKeywordLookup(queryKey, voiceKeywordMap)
      || (numericQueryKey !== queryKey ? fuzzyKeywordLookup(numericQueryKey, voiceKeywordMap) : undefined);
  }

  // Keyword links and free-form queries both go through the shared resolver (search text → first YouTube hit).
  const added = await enqueueFromWeb(client, guildId, { input: resolvedUrl || parsed.query }, requestedBy, 'voice');
  if (!added.success) {
    return {
      ok: false,
      status: 404,
      intent: parsed.intent,
      message: added.error || 'Kappaleen lisäys epäonnistui.',
      error: added.error || 'Failed to queue song',
      resolvedUrl,
    };
  }
  resolvedTitle = added.firstTitle || undefined;

  return {
    ok: true,
    status: 200,
    intent: parsed.intent,
    message: `Lisättiin jonoon: ${resolvedTitle || parsed.query}`,
    queuedTitle: resolvedTitle || parsed.query,
    resolvedUrl,
  };
}
