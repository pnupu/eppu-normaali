// src/voice/finnishParser.ts
import Fuse from 'fuse.js';

export interface ParsedCommand {
  intent: string;
  parameters: Record<string, any>;
  confidence: number;
  originalText: string;
}

export class FinnishCommandParser {
  private commandPatterns: Map<string, RegExp[]>;
  private fuzzySearch!: Fuse<string>;

  constructor() {
    this.commandPatterns = new Map();
    this.setupCommandPatterns();
    this.setupFuzzySearch();
  }

  private setupCommandPatterns(): void {
    // Play commands
    this.commandPatterns.set('PLAY', [
      /toista\s+(.+)/i,
      /soita\s+(.+)/i,
      /toista\s+kappale\s+(.+)/i,
      /soita\s+kappale\s+(.+)/i,
      /toista\s+biisi\s+(.+)/i,
      /soita\s+biisi\s+(.+)/i
    ]);

    // Pause commands
    this.commandPatterns.set('PAUSE', [
      /tauko/i,
      /pysäytä/i,
      /pysäytä\s+musiikki/i,
      /tauota/i
    ]);

    // Resume commands
    this.commandPatterns.set('RESUME', [
      /jatka/i,
      /aloita/i,
      /jatka\s+musiikkia/i,
      /aloita\s+musiikki/i
    ]);

    // Skip commands
    this.commandPatterns.set('SKIP', [
      /seuraava/i,
      /ohita/i,
      /seuraava\s+kappale/i,
      /ohita\s+kappale/i,
      /seuraava\s+biisi/i,
      /ohita\s+biisi/i
    ]);

    // Stop commands
    this.commandPatterns.set('STOP', [
      /lopeta/i,
      /lopeta\s+musiikki/i,
      /pysäytä\s+kaikki/i
    ]);

    // Queue commands
    this.commandPatterns.set('QUEUE', [
      /jono/i,
      /näytä\s+jono/i,
      /mitä\s+soi/i,
      /mikä\s+soi/i,
      /mitä\s+on\s+jonossa/i
    ]);

    // Volume commands
    this.commandPatterns.set('VOLUME', [
      /äänenvoimakkuus\s+ylös/i,
      /äänenvoimakkuus\s+alas/i,
      /kova/i,
      /hiljaa/i,
      /äänenvoimakkuus\s+(\d+)/i
    ]);

    // Favorites commands
    this.commandPatterns.set('FAVORITES_ADD', [
      /lisää\s+suosikkeihin/i,
      /tallenna\s+suosikkeihin/i,
      /lisää\s+nykyinen\s+suosikkeihin/i
    ]);

    this.commandPatterns.set('FAVORITES_PLAY', [
      /toista\s+suosikit/i,
      /soita\s+suosikit/i,
      /toista\s+suosikkilista/i
    ]);

    this.commandPatterns.set('FAVORITES_SHOW', [
      /näytä\s+suosikit/i,
      /listaa\s+suosikit/i,
      /mitä\s+on\s+suosikeissa/i
    ]);

    // Search commands
    this.commandPatterns.set('SEARCH', [
      /etsi\s+(.+)/i,
      /hae\s+(.+)/i,
      /etsi\s+kappale\s+(.+)/i,
      /hae\s+artisti\s+(.+)/i
    ]);

    // Help commands
    this.commandPatterns.set('HELP', [
      /apua/i,
      /ohje/i,
      /mitä\s+voin\s+tehdä/i,
      /käskyt/i
    ]);
  }

  private setupFuzzySearch(): void {
    const commands = [
      'toista', 'soita', 'tauko', 'pysäytä', 'jatka', 'aloita',
      'seuraava', 'ohita', 'lopeta', 'jono', 'äänenvoimakkuus',
      'suosikit', 'etsi', 'hae', 'apua', 'ohje'
    ];

    this.fuzzySearch = new Fuse(commands, {
      threshold: 0.6,
      includeScore: true
    });
  }

  public parseCommand(text: string): ParsedCommand | null {
    // Clean and normalize text
    const cleanText = text.trim().toLowerCase();
    
    // Try exact pattern matching first
    for (const [intent, patterns] of this.commandPatterns) {
      for (const pattern of patterns) {
        const match = cleanText.match(pattern);
        if (match) {
          return this.buildCommand(intent, match, text);
        }
      }
    }

    // Try fuzzy matching for partial commands
    const fuzzyResult = this.fuzzySearch.search(cleanText);
    if (fuzzyResult.length > 0 && fuzzyResult[0].score! < 0.3) {
      const matchedCommand = fuzzyResult[0].item;
      return this.buildFuzzyCommand(matchedCommand, text);
    }

    return null;
  }

  private buildCommand(intent: string, match: RegExpMatchArray, originalText: string): ParsedCommand {
    const parameters: Record<string, any> = {};
    
    // Extract parameters based on intent
    switch (intent) {
      case 'PLAY':
      case 'SEARCH':
        if (match[1]) {
          parameters.song = match[1].trim();
        }
        break;
      case 'VOLUME':
        if (match[1]) {
          parameters.level = match[1];
        } else if (match[0].includes('ylös') || match[0].includes('kova')) {
          parameters.direction = 'up';
        } else if (match[0].includes('alas') || match[0].includes('hiljaa')) {
          parameters.direction = 'down';
        }
        break;
    }

    return {
      intent,
      parameters,
      confidence: 0.9,
      originalText
    };
  }

  private buildFuzzyCommand(matchedCommand: string, originalText: string): ParsedCommand {
    // Map fuzzy matched commands to intents
    const intentMap: Record<string, string> = {
      'toista': 'PLAY',
      'soita': 'PLAY',
      'tauko': 'PAUSE',
      'pysäytä': 'PAUSE',
      'jatka': 'RESUME',
      'aloita': 'RESUME',
      'seuraava': 'SKIP',
      'ohita': 'SKIP',
      'lopeta': 'STOP',
      'jono': 'QUEUE',
      'äänenvoimakkuus': 'VOLUME',
      'suosikit': 'FAVORITES_SHOW',
      'etsi': 'SEARCH',
      'hae': 'SEARCH',
      'apua': 'HELP',
      'ohje': 'HELP'
    };

    const intent = intentMap[matchedCommand] || 'UNKNOWN';
    
    return {
      intent,
      parameters: {},
      confidence: 0.7,
      originalText
    };
  }

  public getCommandHelp(): string {
    return `
Suomenkieliset äänikomennot:

🎵 Musiikkikomennot:
- "Eppu, toista [kappaleen nimi]" - Toista kappale
- "Eppu, tauko" - Tauota musiikki
- "Eppu, jatka" - Jatka musiikkia
- "Eppu, seuraava" - Seuraava kappale
- "Eppu, lopeta" - Lopeta musiikki
- "Eppu, jono" - Näytä jonossa olevat kappaleet

🔊 Äänenvoimakkuus:
- "Eppu, äänenvoimakkuus ylös" - Kova ääni
- "Eppu, äänenvoimakkuus alas" - Hiljaa

⭐ Suosikit:
- "Eppu, lisää suosikkeihin" - Lisää nykyinen kappale suosikkeihin
- "Eppu, toista suosikit" - Toista suosikkilista
- "Eppu, näytä suosikit" - Näytä suosikkilista

🔍 Haku:
- "Eppu, etsi [kappaleen nimi]" - Etsi ja toista kappale
- "Eppu, hae [artisti]" - Hae artistin kappaleita

❓ Apu:
- "Eppu, apua" - Näytä tämä ohje
    `.trim();
  }
}
