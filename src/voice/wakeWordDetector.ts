// src/voice/wakeWordDetector.ts
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { createWriteStream, unlinkSync, existsSync } from 'fs';

export class WakeWordDetector extends EventEmitter {
  private isListening = false;
  private preciseProcess: ChildProcess | null = null;
  private modelPath: string;

  constructor() {
    super();
    
    // Use trained Precise model for Finnish wake phrase detection ("Hei Eppu")
    this.modelPath = path.join(__dirname, '../../train-wake-word/models/hei_eppu.pb');
    this.setupPrecise();
  }

  private setupPrecise(): void {
    // Check if trained model exists
    if (!existsSync(this.modelPath)) {
      console.warn(`Trained model not found: ${this.modelPath}`);
      console.warn('Please train the model first using train-wake-word/train-model.py');
      return;
    }

    console.log(`Using trained model: ${this.modelPath}`);
  }

  private startPrecise(): void {
    if (this.preciseProcess) {
      return; // Already running
    }

    try {
      // Start precise-listen with the trained model
      this.preciseProcess = spawn('precise-listen', [
        this.modelPath,
        '--sensitivity', '0.5',
        '--chunk-size', '1024'
      ]);

      this.preciseProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        if (output.includes('HOTWORD')) {
          console.log('Wake word detected: Hei Eppu');
          this.emit('wakeWordDetected');
        }
      });

      this.preciseProcess.stderr?.on('data', (data: Buffer) => {
        console.error('Precise error:', data.toString());
      });

      this.preciseProcess.on('close', (code: number) => {
        console.log(`Precise process exited with code ${code}`);
        this.preciseProcess = null;
      });

      this.preciseProcess.on('error', (error: Error) => {
        console.error('Precise process error:', error);
        this.preciseProcess = null;
      });

    } catch (error) {
      console.error('Error starting Precise:', error);
      this.preciseProcess = null;
    }
  }

  public startListening(): void {
    if (this.isListening) {
      console.log('Already listening for wake word');
      return;
    }

    if (!existsSync(this.modelPath)) {
      console.error('Cannot start listening: trained model not found');
      console.error('Please train the model first using train-wake-word/train-model.py');
      return;
    }

    this.isListening = true;
    this.startPrecise();
    console.log('Started listening for wake word "Hei Eppu"');
  }

  public stopListening(): void {
    this.isListening = false;
    
    if (this.preciseProcess) {
      this.preciseProcess.kill();
      this.preciseProcess = null;
    }
    
    console.log('Stopped listening for wake word');
  }

  public destroy(): void {
    this.stopListening();
  }
}
