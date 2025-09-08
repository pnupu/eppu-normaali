// src/voice/gptRealtimeHandler.ts
import OpenAI from 'openai';
import { EventEmitter } from 'events';

export interface VoiceCommand {
  intent: string;
  parameters: Record<string, any>;
  confidence: number;
  originalText: string;
}

export class GPTRealtimeHandler extends EventEmitter {
  private openai: OpenAI;
  private isProcessing = false;

  constructor() {
    super();
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  public async processVoiceCommand(audioBuffer: Buffer): Promise<VoiceCommand | null> {
    if (this.isProcessing) {
      console.log('Already processing a voice command');
      return null;
    }

    this.isProcessing = true;

    try {
      // Convert audio buffer to base64 for OpenAI API
      const audioBase64 = audioBuffer.toString('base64');
      
      // Use OpenAI's audio transcription API
      const transcription = await this.openai.audio.transcriptions.create({
        file: new File([audioBuffer], 'audio.wav', { type: 'audio/wav' }),
        model: 'whisper-1',
        language: 'fi', // Finnish
        response_format: 'text'
      });

      console.log('Transcribed speech:', transcription);

      // Parse the Finnish command
      const command = await this.parseFinnishCommand(transcription);
      
      this.isProcessing = false;
      return command;

    } catch (error) {
      console.error('Error processing voice command:', error);
      this.isProcessing = false;
      return null;
    }
  }

  private async parseFinnishCommand(text: string): Promise<VoiceCommand | null> {
    try {
      // Use GPT to parse Finnish commands into structured data
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a Finnish voice command parser for a Discord music bot named "Eppu". 
            Parse the following Finnish text into a JSON command structure.
            
            Available commands:
            - PLAY: "toista [song]", "soita [song]", "toista [artist]"
            - PAUSE: "tauko", "pysäytä"
            - RESUME: "jatka", "aloita"
            - SKIP: "seuraava", "ohita", "seuraava kappale"
            - STOP: "lopeta", "pysäytä musiikki"
            - QUEUE: "jono", "näytä jono"
            - VOLUME: "äänenvoimakkuus ylös/alas", "kova/hiljaa"
            - FAVORITES: "lisää suosikkeihin", "toista suosikit", "näytä suosikit"
            - SEARCH: "etsi [song]", "hae [artist]"
            - HELP: "apua", "ohje"
            
            Return JSON in format: {
              "intent": "COMMAND_NAME",
              "parameters": {"song": "song name", "artist": "artist name"},
              "confidence": 0.95,
              "originalText": "original text"
            }`
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.1,
        max_tokens: 200
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from GPT');
      }

      // Parse JSON response
      const command = JSON.parse(content) as VoiceCommand;
      
      // Validate command structure
      if (!command.intent || !command.parameters) {
        throw new Error('Invalid command structure');
      }

      return command;

    } catch (error) {
      console.error('Error parsing Finnish command:', error);
      return null;
    }
  }

  public async getVoiceFeedback(message: string): Promise<Buffer> {
    try {
      // Use OpenAI's TTS for Finnish voice feedback
      const response = await this.openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova', // Good for Finnish
        input: message,
        response_format: 'mp3'
      });

      const buffer = Buffer.from(await response.arrayBuffer());
      return buffer;

    } catch (error) {
      console.error('Error generating voice feedback:', error);
      throw error;
    }
  }
}
