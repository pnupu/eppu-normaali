// src/voice/voiceFeedback.ts
import { spawn } from 'child_process';
import { createWriteStream, unlinkSync } from 'fs';
import path from 'path';
import { GPTRealtimeHandler } from './gptRealtimeHandler';

export class VoiceFeedback {
  private gptHandler: GPTRealtimeHandler;
  private tempDir: string;

  constructor() {
    this.gptHandler = new GPTRealtimeHandler();
    this.tempDir = path.join(__dirname, '../../temp');
  }

  public async speakFinnish(text: string): Promise<void> {
    try {
      // Use espeak-ng for Finnish TTS (lightweight, good for Raspberry Pi)
      const audioFile = path.join(this.tempDir, `feedback_${Date.now()}.wav`);
      
      // Ensure temp directory exists
      const { mkdirSync } = require('fs');
      try {
        mkdirSync(this.tempDir, { recursive: true });
      } catch (error) {
        // Directory might already exist
      }

      return new Promise((resolve, reject) => {
        const espeak = spawn('espeak-ng', [
          '-v', 'fi',           // Finnish voice
          '-s', '150',          // Speed (words per minute)
          '-p', '50',           // Pitch (0-99)
          '-a', '100',          // Amplitude (0-200)
          '-w', audioFile,      // Output file
          text
        ]);

        espeak.on('close', (code) => {
          if (code === 0) {
            // Play the generated audio
            this.playAudioFile(audioFile)
              .then(() => {
                // Clean up the temporary file
                try {
                  unlinkSync(audioFile);
                } catch (error) {
                  console.error('Error deleting temp audio file:', error);
                }
                resolve();
              })
              .catch(reject);
          } else {
            reject(new Error(`espeak-ng exited with code ${code}`));
          }
        });

        espeak.on('error', (error) => {
          console.error('espeak-ng error:', error);
          reject(error);
        });
      });

    } catch (error) {
      console.error('Error generating voice feedback:', error);
      throw error;
    }
  }

  public async speakWithOpenAI(text: string): Promise<void> {
    try {
      const audioBuffer = await this.gptHandler.getVoiceFeedback(text);
      const audioFile = path.join(this.tempDir, `feedback_${Date.now()}.mp3`);
      
      // Write buffer to file
      const { writeFileSync } = require('fs');
      writeFileSync(audioFile, audioBuffer);

      await this.playAudioFile(audioFile);
      
      // Clean up
      try {
        unlinkSync(audioFile);
      } catch (error) {
        console.error('Error deleting temp audio file:', error);
      }

    } catch (error) {
      console.error('Error with OpenAI TTS:', error);
      // Fallback to espeak-ng
      await this.speakFinnish(text);
    }
  }

  private async playAudioFile(audioFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use aplay for audio playback on Raspberry Pi
      const aplay = spawn('aplay', [audioFile]);

      aplay.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`aplay exited with code ${code}`));
        }
      });

      aplay.on('error', (error) => {
        console.error('aplay error:', error);
        reject(error);
      });
    });
  }

  public getFinnishResponses(): Record<string, string> {
    return {
      // Music control responses
      'play_started': 'Toistetaan kappaletta',
      'play_paused': 'Musiikki tauotettu',
      'play_resumed': 'Musiikki jatkuu',
      'play_skipped': 'Seuraava kappale',
      'play_stopped': 'Musiikki lopetettu',
      
      // Queue responses
      'queue_empty': 'Jono on tyhjä',
      'queue_show': 'Näytetään jono',
      'queue_cleared': 'Jono tyhjennetty',
      
      // Favorites responses
      'favorite_added': 'Lisätty suosikkeihin',
      'favorite_removed': 'Poistettu suosikeista',
      'favorites_playing': 'Toistetaan suosikkilistaa',
      'favorites_empty': 'Suosikkilista on tyhjä',
      
      // Search responses
      'search_found': 'Löytyi hakutuloksia',
      'search_not_found': 'Ei hakutuloksia',
      'search_playing': 'Toistetaan hakutulos',
      
      // Error responses
      'error_general': 'Tapahtui virhe',
      'error_no_voice_channel': 'Sinun täytyy olla äänikanavassa',
      'error_no_music': 'Musiikkia ei soi',
      'error_command_not_understood': 'En ymmärtänyt komentoa',
      
      // Help responses
      'help_shown': 'Näytetään ohje',
      
      // Volume responses
      'volume_up': 'Äänenvoimakkuus kovemmaksi',
      'volume_down': 'Äänenvoimakkuus hiljaisemmaksi',
      'volume_set': 'Äänenvoimakkuus asetettu'
    };
  }

  public async respondToCommand(command: string, success: boolean = true, details?: any): Promise<void> {
    const responses = this.getFinnishResponses();
    let responseText = '';

    switch (command) {
      case 'PLAY':
        responseText = success ? responses.play_started : responses.error_general;
        if (success && details?.title) {
          responseText += `: ${details.title}`;
        }
        break;
      case 'PAUSE':
        responseText = success ? responses.play_paused : responses.error_no_music;
        break;
      case 'RESUME':
        responseText = success ? responses.play_resumed : responses.error_no_music;
        break;
      case 'SKIP':
        responseText = success ? responses.play_skipped : responses.error_no_music;
        break;
      case 'STOP':
        responseText = success ? responses.play_stopped : responses.error_no_music;
        break;
      case 'QUEUE':
        responseText = success ? responses.queue_show : responses.queue_empty;
        break;
      case 'FAVORITES_ADD':
        responseText = success ? responses.favorite_added : responses.error_general;
        break;
      case 'FAVORITES_PLAY':
        responseText = success ? responses.favorites_playing : responses.favorites_empty;
        break;
      case 'SEARCH':
        responseText = success ? responses.search_playing : responses.search_not_found;
        if (success && details?.title) {
          responseText += `: ${details.title}`;
        }
        break;
      case 'HELP':
        responseText = responses.help_shown;
        break;
      default:
        responseText = success ? 'Komento suoritettu' : responses.error_command_not_understood;
    }

    await this.speakFinnish(responseText);
  }
}
