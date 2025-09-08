// src/voice/voiceCommands.ts
import { Message } from 'discord.js';
import { WakeWordDetector } from './wakeWordDetector';
import { GPTRealtimeHandler, VoiceCommand } from './gptRealtimeHandler';
import { FinnishCommandParser, ParsedCommand } from './finnishParser';
import { VoiceFeedback } from './voiceFeedback';
import { FavoritesManager } from '../music/favorites';
import { MusicSearch } from '../music/search';
import { handlePlay, handlePause, handleResume, handleSkip, handleQueue } from '../commands/play';
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import path from 'path';

export class VoiceCommandHandler {
  private wakeWordDetector: WakeWordDetector;
  private gptHandler: GPTRealtimeHandler;
  private commandParser: FinnishCommandParser;
  private voiceFeedback: VoiceFeedback;
  private favoritesManager: FavoritesManager;
  private searchEngine: MusicSearch;
  private isListening = false;
  private currentAudioProcess: any = null;
  private tempDir: string;

  constructor() {
    this.wakeWordDetector = new WakeWordDetector();
    this.gptHandler = new GPTRealtimeHandler();
    this.commandParser = new FinnishCommandParser();
    this.voiceFeedback = new VoiceFeedback();
    this.favoritesManager = new FavoritesManager();
    this.searchEngine = new MusicSearch();
    this.tempDir = path.join(__dirname, '../../temp');

    this.setupWakeWordListener();
  }

  private setupWakeWordListener(): void {
    this.wakeWordDetector.on('wakeWordDetected', () => {
      console.log('Wake word detected, starting voice command capture...');
      this.startVoiceCommandCapture();
    });
  }

  public startListening(): void {
    if (this.isListening) {
      console.log('Already listening for voice commands');
      return;
    }

    this.isListening = true;
    this.wakeWordDetector.startListening();
    console.log('Voice command handler started - listening for "Eppu"');
  }

  public stopListening(): void {
    this.isListening = false;
    this.wakeWordDetector.stopListening();
    this.stopVoiceCommandCapture();
    console.log('Voice command handler stopped');
  }

  private startVoiceCommandCapture(): void {
    if (this.currentAudioProcess) {
      this.currentAudioProcess.kill();
    }

    // Capture audio for 5 seconds after wake word
    const audioFile = path.join(this.tempDir, `voice_command_${Date.now()}.wav`);
    
    this.currentAudioProcess = spawn('arecord', [
      '-f', 'S16_LE',
      '-r', '16000',
      '-c', '1',
      '-D', 'plughw:1,0',
      '-d', '5', // Record for 5 seconds
      audioFile
    ]);

    this.currentAudioProcess.on('close', () => {
      this.processVoiceCommand(audioFile);
    });

    this.currentAudioProcess.on('error', (error: Error) => {
      console.error('Error capturing voice command:', error);
    });
  }

  private stopVoiceCommandCapture(): void {
    if (this.currentAudioProcess) {
      this.currentAudioProcess.kill();
      this.currentAudioProcess = null;
    }
  }

  private async processVoiceCommand(audioFile: string): Promise<void> {
    try {
      // Read the audio file
      const { readFileSync, unlinkSync } = require('fs');
      const audioBuffer = readFileSync(audioFile);
      
      // Process with GPT-realtime
      const voiceCommand = await this.gptHandler.processVoiceCommand(audioBuffer);
      
      if (voiceCommand) {
        await this.executeVoiceCommand(voiceCommand);
      } else {
        // Fallback to local parsing
        const transcription = await this.transcribeAudio(audioFile);
        if (transcription) {
          const parsedCommand = this.commandParser.parseCommand(transcription);
          if (parsedCommand) {
            await this.executeParsedCommand(parsedCommand);
          } else {
            await this.voiceFeedback.speakFinnish('En ymmärtänyt komentoa');
          }
        }
      }

      // Clean up audio file
      try {
        unlinkSync(audioFile);
      } catch (error) {
        console.error('Error deleting audio file:', error);
      }

    } catch (error) {
      console.error('Error processing voice command:', error);
      await this.voiceFeedback.speakFinnish('Tapahtui virhe äänikomennon käsittelyssä');
    }
  }

  private async transcribeAudio(audioFile: string): Promise<string | null> {
    try {
      // Use whisper for local transcription as fallback
      const whisper = spawn('whisper', [audioFile, '--language', 'fi', '--output_format', 'txt']);
      
      return new Promise((resolve, reject) => {
        let output = '';
        
        whisper.stdout.on('data', (data) => {
          output += data.toString();
        });

        whisper.on('close', (code) => {
          if (code === 0) {
            resolve(output.trim());
          } else {
            reject(new Error(`Whisper exited with code ${code}`));
          }
        });

        whisper.on('error', (error) => {
          reject(error);
        });
      });
    } catch (error) {
      console.error('Error transcribing audio:', error);
      return null;
    }
  }

  private async executeVoiceCommand(command: VoiceCommand): Promise<void> {
    console.log('Executing voice command:', command);
    
    try {
      switch (command.intent) {
        case 'PLAY':
          await this.handlePlayCommand(command);
          break;
        case 'PAUSE':
          await this.handlePauseCommand();
          break;
        case 'RESUME':
          await this.handleResumeCommand();
          break;
        case 'SKIP':
          await this.handleSkipCommand();
          break;
        case 'STOP':
          await this.handleStopCommand();
          break;
        case 'QUEUE':
          await this.handleQueueCommand();
          break;
        case 'FAVORITES_ADD':
          await this.handleAddFavoriteCommand();
          break;
        case 'FAVORITES_PLAY':
          await this.handlePlayFavoritesCommand();
          break;
        case 'FAVORITES_SHOW':
          await this.handleShowFavoritesCommand();
          break;
        case 'SEARCH':
          await this.handleSearchCommand(command);
          break;
        case 'HELP':
          await this.handleHelpCommand();
          break;
        default:
          await this.voiceFeedback.speakFinnish('Tuntematon komento');
      }
    } catch (error) {
      console.error('Error executing voice command:', error);
      await this.voiceFeedback.speakFinnish('Virhe komennon suorittamisessa');
    }
  }

  private async executeParsedCommand(command: ParsedCommand): Promise<void> {
    // Convert ParsedCommand to VoiceCommand format
    const voiceCommand: VoiceCommand = {
      intent: command.intent,
      parameters: command.parameters,
      confidence: command.confidence,
      originalText: command.originalText
    };
    
    await this.executeVoiceCommand(voiceCommand);
  }

  // Command handlers
  private async handlePlayCommand(command: VoiceCommand): Promise<void> {
    const songQuery = command.parameters.song;
    if (!songQuery) {
      await this.voiceFeedback.speakFinnish('Mikä kappale?');
      return;
    }

    // Search for the song
    const searchResults = await this.searchEngine.searchSongs(songQuery, 1);
    if (searchResults.length === 0) {
      await this.voiceFeedback.speakFinnish('Kappaletta ei löytynyt');
      return;
    }

    const song = searchResults[0];
    // Note: We need access to the Discord message object to call handlePlay
    // This would need to be passed from the main bot
    await this.voiceFeedback.speakFinnish(`Toistetaan: ${song.title}`);
  }

  private async handlePauseCommand(): Promise<void> {
    // Note: Need Discord message object
    await this.voiceFeedback.speakFinnish('Tauotetaan musiikki');
  }

  private async handleResumeCommand(): Promise<void> {
    // Note: Need Discord message object
    await this.voiceFeedback.speakFinnish('Jatketaan musiikkia');
  }

  private async handleSkipCommand(): Promise<void> {
    // Note: Need Discord message object
    await this.voiceFeedback.speakFinnish('Seuraava kappale');
  }

  private async handleStopCommand(): Promise<void> {
    // Note: Need Discord message object
    await this.voiceFeedback.speakFinnish('Lopetetaan musiikki');
  }

  private async handleQueueCommand(): Promise<void> {
    // Note: Need Discord message object
    await this.voiceFeedback.speakFinnish('Näytetään jono');
  }

  private async handleAddFavoriteCommand(): Promise<void> {
    // Note: Need current song info and user info
    await this.voiceFeedback.speakFinnish('Lisätään suosikkeihin');
  }

  private async handlePlayFavoritesCommand(): Promise<void> {
    // Note: Need user info
    await this.voiceFeedback.speakFinnish('Toistetaan suosikkilistaa');
  }

  private async handleShowFavoritesCommand(): Promise<void> {
    // Note: Need user info
    await this.voiceFeedback.speakFinnish('Näytetään suosikit');
  }

  private async handleSearchCommand(command: VoiceCommand): Promise<void> {
    const searchQuery = command.parameters.song;
    if (!searchQuery) {
      await this.voiceFeedback.speakFinnish('Mitä etsitään?');
      return;
    }

    const searchResults = await this.searchEngine.searchSongs(searchQuery, 5);
    if (searchResults.length === 0) {
      await this.voiceFeedback.speakFinnish('Hakutuloksia ei löytynyt');
      return;
    }

    await this.voiceFeedback.speakFinnish(`Löytyi ${searchResults.length} hakutulosta`);
  }

  private async handleHelpCommand(): Promise<void> {
    const helpText = this.commandParser.getCommandHelp();
    await this.voiceFeedback.speakFinnish('Näytetään ohje');
    // Note: Would also send help text to Discord channel
  }

  public destroy(): void {
    this.stopListening();
    this.wakeWordDetector.destroy();
    this.favoritesManager.close();
  }
}
