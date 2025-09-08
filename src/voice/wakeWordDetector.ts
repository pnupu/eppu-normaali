// src/voice/wakeWordDetector.ts
import { Porcupine } from '@picovoice/porcupine-node';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export class WakeWordDetector extends EventEmitter {
  private porcupine: Porcupine;
  private isListening = false;
  private audioProcess: ChildProcess | null = null;
  private audioBuffer: Buffer[] = [];

  constructor() {
    super();
    
    // Initialize Porcupine with Finnish wake word "Eppu"
    this.porcupine = new Porcupine(
      process.env.PICOVOICE_ACCESS_KEY || '',
      ['Eppu'], // Wake word
      [0.7]     // Sensitivity
    );

    this.setupAudioCapture();
  }

  private setupAudioCapture(): void {
    // Use ALSA for direct audio capture on Raspberry Pi
    // Adjust device based on your Pi's audio setup
    this.audioProcess = spawn('arecord', [
      '-f', 'S16_LE',    // 16-bit signed little endian
      '-r', '16000',     // 16kHz sample rate
      '-c', '1',         // Mono channel
      '-D', 'plughw:1,0', // Audio device (adjust as needed)
      '--buffer-size=1024'
    ]);

    this.audioProcess.stdout?.on('data', (chunk: Buffer) => {
      if (this.isListening) {
        this.processAudioChunk(chunk);
      }
    });

    this.audioProcess.stderr?.on('data', (data) => {
      console.error('Audio capture error:', data.toString());
    });

    this.audioProcess.on('close', (code) => {
      console.log(`Audio capture process exited with code ${code}`);
    });
  }

  private processAudioChunk(chunk: Buffer): void {
    this.audioBuffer.push(chunk);
    
    // Process in chunks of 512 samples (1024 bytes for 16-bit audio)
    const chunkSize = 1024;
    while (this.audioBuffer.length >= chunkSize) {
      const audioData = Buffer.concat(this.audioBuffer.splice(0, chunkSize));
      
      try {
        // Convert buffer to Int16Array for Porcupine
        const samples = new Int16Array(audioData.buffer, audioData.byteOffset, audioData.length / 2);
        const keywordIndex = this.porcupine.process(samples);
        
        if (keywordIndex >= 0) {
          console.log('Wake word detected: Eppu');
          this.emit('wakeWordDetected');
        }
      } catch (error) {
        console.error('Error processing audio chunk:', error);
      }
    }
  }

  public startListening(): void {
    if (this.isListening) {
      console.log('Already listening for wake word');
      return;
    }

    this.isListening = true;
    this.audioBuffer = [];
    console.log('Started listening for wake word "Eppu"');
  }

  public stopListening(): void {
    this.isListening = false;
    console.log('Stopped listening for wake word');
  }

  public destroy(): void {
    this.stopListening();
    if (this.audioProcess) {
      this.audioProcess.kill();
      this.audioProcess = null;
    }
    this.porcupine.release();
  }
}
