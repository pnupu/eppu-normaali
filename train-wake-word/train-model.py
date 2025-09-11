#!/usr/bin/env python3
"""
Training script for Finnish wake phrase "Hei Eppu" using Mycroft Precise
"""

import os
import subprocess
import sys
from pathlib import Path

class WakeWordTrainer:
    def __init__(self, model_name="hei_eppu"):
        self.model_name = model_name
        self.data_dir = "wake-word"
        self.model_dir = "models"
        
    def check_dependencies(self):
        """Check if required dependencies are installed"""
        print("Checking dependencies...")
        
        try:
            import precise_runner
            print("✅ precise-runner installed")
        except ImportError:
            print("❌ precise-runner not found")
            print("Install with: pip install precise-runner")
            return False
            
        try:
            import tensorflow
            print("✅ tensorflow installed")
        except ImportError:
            print("❌ tensorflow not found")
            print("Install with: pip install tensorflow")
            return False
            
        return True
    
    def check_data(self):
        """Check if training data is available"""
        print("\nChecking training data...")
        
        wake_word_dir = Path(self.data_dir) / "wake-word"
        not_wake_word_dir = Path(self.data_dir) / "not-wake-word"
        
        if not wake_word_dir.exists():
            print(f"❌ Wake word directory not found: {wake_word_dir}")
            return False
            
        if not not_wake_word_dir.exists():
            print(f"❌ Not wake word directory not found: {not_wake_word_dir}")
            return False
        
        wake_word_count = len(list(wake_word_dir.glob("*.wav")))
        not_wake_word_count = len(list(not_wake_word_dir.glob("*.wav")))
        
        print(f"✅ Wake word samples: {wake_word_count}")
        print(f"✅ Negative samples: {not_wake_word_count}")
        
        if wake_word_count < 50:
            print("⚠️  Warning: Less than 50 wake word samples. Consider collecting more.")
            
        if not_wake_word_count < 100:
            print("⚠️  Warning: Less than 100 negative samples. Consider collecting more.")
            
        if wake_word_count == 0 or not_wake_word_count == 0:
            print("❌ No training data found. Run collect-data.py first.")
            return False
            
        return True
    
    def prepare_data(self):
        """Prepare data for training"""
        print("\nPreparing data for training...")
        
        # Create models directory
        os.makedirs(self.model_dir, exist_ok=True)
        
        # Check audio format and convert if necessary
        self.convert_audio_format()
        
        print("✅ Data preparation complete")
    
    def convert_audio_format(self):
        """Convert audio files to the correct format for Precise"""
        print("Converting audio files to 16kHz, 16-bit, mono...")
        
        try:
            import librosa
            import soundfile as sf
            
            for category in ['wake-word', 'not-wake-word']:
                category_dir = Path(self.data_dir) / category
                converted_dir = category_dir / 'converted'
                converted_dir.mkdir(exist_ok=True)
                
                for audio_file in category_dir.glob("*.wav"):
                    try:
                        # Load audio
                        audio, sr = librosa.load(audio_file, sr=16000, mono=True)
                        
                        # Convert to 16-bit
                        audio_16bit = (audio * 32767).astype('int16')
                        
                        # Save converted file
                        output_file = converted_dir / audio_file.name
                        sf.write(output_file, audio_16bit, 16000, subtype='PCM_16')
                        
                    except Exception as e:
                        print(f"Warning: Could not convert {audio_file}: {e}")
                        
        except ImportError:
            print("librosa not available. Install with: pip install librosa")
            print("Skipping audio conversion...")
    
    def train_model(self):
        """Train the wake word model"""
        print(f"\nTraining wake word model: {self.model_name}")
        
        try:
            # Use precise-train command (model first, then dataset dir)
            cmd = [
                'precise-train',
                '-e', '60',
                '-b', '64',
                str(Path(self.model_dir) / f"{self.model_name}.net"),
                str(Path(self.data_dir))
            ]
            
            print(f"Running: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ Training completed successfully!")
                print(result.stdout)
            else:
                print("❌ Training failed!")
                print("Error:", result.stderr)
                return False
                
        except FileNotFoundError:
            print("❌ precise-train command not found")
            print("Make sure precise-runner is installed correctly")
            return False
        except Exception as e:
            print(f"❌ Training error: {e}")
            return False
            
        return True
    
    def convert_to_edge_model(self):
        """Convert the trained model to edge format"""
        print(f"\nConverting model to edge format...")
        
        try:
            net_file = Path(self.model_dir) / f"{self.model_name}.net"
            pb_file = Path(self.model_dir) / f"{self.model_name}.pb"
            
            if not net_file.exists():
                print(f"❌ Trained model not found: {net_file}")
                return False
            
            cmd = [
                'precise-convert',
                str(net_file),
                str(pb_file)
            ]
            
            print(f"Running: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ Model conversion completed!")
                print(f"Edge model saved: {pb_file}")
                return True
            else:
                print("❌ Model conversion failed!")
                print("Error:", result.stderr)
                return False
                
        except FileNotFoundError:
            print("❌ precise-convert command not found")
            return False
        except Exception as e:
            print(f"❌ Conversion error: {e}")
            return False
    
    def test_model(self):
        """Test the trained model"""
        print(f"\nTesting the trained model...")
        
        try:
            pb_file = Path(self.model_dir) / f"{self.model_name}.pb"
            
            if not pb_file.exists():
                print(f"❌ Edge model not found: {pb_file}")
                return False
            
            # Test with precise-listen
            cmd = [
                'precise-listen',
                str(pb_file),
                '--sensitivity', '0.5',
                '--timeout', '10'
            ]
            
            print(f"Running: {' '.join(cmd)}")
            print("Say 'Hei Eppu' to test the model (10 second timeout)")
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            
            if "HOTWORD" in result.stdout:
                print("✅ Model test successful! Wake word detected.")
                return True
            else:
                print("⚠️  No wake word detected in test. Model may need more training.")
                return False
                
        except subprocess.TimeoutExpired:
            print("⚠️  Test timeout. No wake word detected.")
            return False
        except Exception as e:
            print(f"❌ Test error: {e}")
            return False
    
    def run_full_training(self):
        """Run the complete training pipeline"""
        print("=== Finnish Wake Word Training Pipeline ===")
        print(f"Model name: {self.model_name}")
        
        # Check dependencies
        if not self.check_dependencies():
            return False
        
        # Check data
        if not self.check_data():
            return False
        
        # Prepare data
        self.prepare_data()
        
        # Train model
        if not self.train_model():
            return False
        
        # Convert to edge model
        if not self.convert_to_edge_model():
            return False
        
        # Test model
        self.test_model()
        
        print("\n=== Training Complete ===")
        print(f"Model files:")
        print(f"  - {self.model_dir}/{self.model_name}.net (training model)")
        print(f"  - {self.model_dir}/{self.model_name}.pb (edge model)")
        print("\nTo use the model in your bot:")
        print(f"  precise-listen {self.model_dir}/{self.model_name}.pb")
        
        return True

def main():
    if len(sys.argv) > 1:
        model_name = sys.argv[1]
    else:
        model_name = "hei_eppu"
    
    trainer = WakeWordTrainer(model_name)
    trainer.run_full_training()

if __name__ == "__main__":
    main()
