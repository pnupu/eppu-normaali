#!/usr/bin/env python3
"""
Data collection script for training Finnish wake phrase "Hei Eppu"
"""

import os
import time
import sounddevice as sd
import soundfile as sf
import numpy as np
from datetime import datetime

class DataCollector:
    def __init__(self, sample_rate=16000, duration=2):
        self.sample_rate = sample_rate
        self.duration = duration
        self.setup_directories()
    
    def setup_directories(self):
        """Create necessary directories for data collection"""
        os.makedirs('wake-word/wake-word', exist_ok=True)
        os.makedirs('wake-word/not-wake-word', exist_ok=True)
        print("Directories created: wake-word/wake-word and wake-word/not-wake-word")
    
    def record_audio(self, filename, category):
        """Record audio sample"""
        print(f"\nRecording {category} sample...")
        print("Speak now!")
        
        try:
            # Record audio
            audio = sd.rec(int(self.duration * self.sample_rate), 
                          samplerate=self.sample_rate, 
                          channels=1, 
                          dtype='int16')
            sd.wait()
            
            # Save audio
            filepath = f'wake-word/{category}/{filename}'
            sf.write(filepath, audio, self.sample_rate)
            
            print(f"Saved: {filepath}")
            return filepath
            
        except Exception as e:
            print(f"Error recording audio: {e}")
            print("Make sure your microphone is working and not being used by another app")
            return None
    
    def collect_wake_word_samples(self, count=100):
        """Collect positive samples of 'Hei Eppu'"""
        print(f"\n=== Collecting {count} wake word samples ===")
        print("Say 'Hei Eppu' in different ways:")
        print("- Normal tone")
        print("- Excited tone") 
        print("- Questioning tone")
        print("- Whispered")
        print("- Loud")
        
        for i in range(count):
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"hei_eppu_{i+1:03d}_{timestamp}.wav"
            
            try:
                self.record_audio(filename, 'wake-word')
                
                # Ask for confirmation
                response = input("Good sample? (y/n/q to quit): ").lower()
                if response == 'q':
                    break
                elif response == 'n':
                    # Delete the file and try again
                    os.remove(f'wake-word/wake-word/{filename}')
                    i -= 1
                    continue
                    
            except KeyboardInterrupt:
                print("\nCollection stopped by user")
                break
    
    def collect_negative_samples(self, count=200):
        """Collect negative samples"""
        print(f"\n=== Collecting {count} negative samples ===")
        print("Say other Finnish words or phrases:")
        print("- 'hei', 'moi', 'terve'")
        print("- 'kiitos', 'ole hyvä'")
        print("- 'mitä kuuluu', 'hyvää päivää'")
        print("- Background noise, music, etc.")
        
        negative_words = [
            'hei', 'moi', 'terve', 'kiitos', 'ole_hyva', 'mita_kuuluu',
            'hyvaa_paivaa', 'näkemiin', 'anteeksi', 'ei_hätää'
        ]
        
        for i in range(count):
            word = negative_words[i % len(negative_words)]
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"{word}_{i+1:03d}_{timestamp}.wav"
            
            try:
                self.record_audio(filename, 'not-wake-word')
                
                # Ask for confirmation
                response = input("Good sample? (y/n/q to quit): ").lower()
                if response == 'q':
                    break
                elif response == 'n':
                    # Delete the file and try again
                    os.remove(f'wake-word/not-wake-word/{filename}')
                    i -= 1
                    continue
                    
            except KeyboardInterrupt:
                print("\nCollection stopped by user")
                break
    
    def generate_tts_samples(self, count=50):
        """Generate synthetic samples using TTS"""
        try:
            import pyttsx3
            
            print(f"\n=== Generating {count} TTS samples ===")
            engine = pyttsx3.init()
            
            # Try to set Finnish voice
            voices = engine.getProperty('voices')
            finnish_voice = None
            for voice in voices:
                if 'finnish' in voice.name.lower() or 'fi' in voice.id.lower():
                    finnish_voice = voice
                    break
            
            if finnish_voice:
                engine.setProperty('voice', finnish_voice.id)
                print("Using Finnish TTS voice")
            else:
                print("Using default TTS voice")
            
            engine.setProperty('rate', 150)
            
            for i in range(count):
                filename = f"hei_eppu_tts_{i+1:03d}.wav"
                filepath = f'wake-word/wake-word/{filename}'
                
                engine.say("Hei Eppu")
                engine.save_to_file("Hei Eppu", filepath)
                engine.runAndWait()
                
                print(f"Generated: {filepath}")
                
        except ImportError:
            print("pyttsx3 not available. Install with: pip install pyttsx3")
        except Exception as e:
            print(f"TTS generation failed: {e}")

def main():
    print("=== Finnish Wake Word Data Collection ===")
    print("Target phrase: 'Hei Eppu'")
    print("Sample rate: 16kHz, Duration: 2 seconds")
    
    collector = DataCollector()
    
    while True:
        print("\nChoose an option:")
        print("1. Collect wake word samples (Hei Eppu)")
        print("2. Collect negative samples")
        print("3. Generate TTS samples")
        print("4. Show statistics")
        print("5. Exit")
        
        choice = input("Enter choice (1-5): ").strip()
        
        if choice == '1':
            count = int(input("How many samples? (default 100): ") or "100")
            collector.collect_wake_word_samples(count)
        elif choice == '2':
            count = int(input("How many samples? (default 200): ") or "200")
            collector.collect_negative_samples(count)
        elif choice == '3':
            count = int(input("How many samples? (default 50): ") or "50")
            collector.generate_tts_samples(count)
        elif choice == '4':
            show_statistics()
        elif choice == '5':
            break
        else:
            print("Invalid choice")

def show_statistics():
    """Show data collection statistics"""
    wake_word_count = len(os.listdir('wake-word/wake-word'))
    not_wake_word_count = len(os.listdir('wake-word/not-wake-word'))
    
    print(f"\n=== Data Collection Statistics ===")
    print(f"Wake word samples: {wake_word_count}")
    print(f"Negative samples: {not_wake_word_count}")
    print(f"Total samples: {wake_word_count + not_wake_word_count}")
    
    if wake_word_count > 0 and not_wake_word_count > 0:
        ratio = wake_word_count / not_wake_word_count
        print(f"Positive/Negative ratio: {ratio:.2f}")
        if ratio < 0.3:
            print("⚠️  Consider collecting more positive samples")
        elif ratio > 0.7:
            print("⚠️  Consider collecting more negative samples")
        else:
            print("✅ Good balance of positive and negative samples")

if __name__ == "__main__":
    main()
