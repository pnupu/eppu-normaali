#!/usr/bin/env python3
"""
Test script for trained wake phrase model ("Hei Eppu")
"""

import os
import sys
import subprocess
from pathlib import Path

def test_model():
    """Test the trained wake word model"""
    
    model_path = Path("models/hei_eppu.pb")
    
    if not model_path.exists():
        print("❌ Trained model not found: models/eppu.pb")
        print("Please train the model first: python train-model.py")
        return False
    
    print("=== Testing Wake Word Model ===")
    print(f"Model: {model_path}")
    print("Say 'Hei Eppu' to test the model (10 second timeout)")
    print("Press Ctrl+C to stop early")
    print()
    
    try:
        # Test with precise-listen
        cmd = [
            'precise-listen',
            str(model_path),
            '--sensitivity', '0.5',
            '--timeout', '10'
        ]
        
        print(f"Running: {' '.join(cmd)}")
        print()
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        
        if "HOTWORD" in result.stdout:
            print("✅ SUCCESS: Wake word detected!")
            print("Model is working correctly")
            return True
        else:
            print("⚠️  No wake word detected in test")
            print("This could be normal if you didn't say 'Hei Eppu'")
            print("Try running the test again and say 'Hei Eppu' clearly")
            return False
            
    except subprocess.TimeoutExpired:
        print("⚠️  Test timeout (10 seconds)")
        print("No wake word detected - this is normal if you didn't say 'Hei Eppu'")
        return False
    except FileNotFoundError:
        print("❌ precise-listen command not found")
        print("Make sure precise-runner is installed:")
        print("  pip install precise-runner")
        return False
    except KeyboardInterrupt:
        print("\n⏹️  Test stopped by user")
        return False
    except Exception as e:
        print(f"❌ Test error: {e}")
        return False

def test_with_different_sensitivity():
    """Test model with different sensitivity settings"""
    
    model_path = Path("models/hei_eppu.pb")
    if not model_path.exists():
        print("❌ Model not found")
        return
    
    print("\n=== Testing Different Sensitivity Settings ===")
    
    sensitivities = [0.3, 0.5, 0.7]
    
    for sensitivity in sensitivities:
        print(f"\nTesting sensitivity: {sensitivity}")
        print("Say 'Hei Eppu' to test (5 second timeout)")
        
        try:
            cmd = [
                'precise-listen',
                str(model_path),
                '--sensitivity', str(sensitivity),
                '--timeout', '5'
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
            
            if "HOTWORD" in result.stdout:
                print(f"✅ Detected at sensitivity {sensitivity}")
            else:
                print(f"❌ Not detected at sensitivity {sensitivity}")
                
        except subprocess.TimeoutExpired:
            print(f"⏰ Timeout at sensitivity {sensitivity}")
        except Exception as e:
            print(f"❌ Error at sensitivity {sensitivity}: {e}")

def show_model_info():
    """Show information about the trained model"""
    
    model_path = Path("models/hei_eppu.pb")
    net_path = Path("models/hei_eppu.net")
    
    print("=== Model Information ===")
    
    if model_path.exists():
        size = model_path.stat().st_size
        print(f"✅ Edge model: {model_path} ({size:,} bytes)")
    else:
        print("❌ Edge model not found")
    
    if net_path.exists():
        size = net_path.stat().st_size
        print(f"✅ Training model: {net_path} ({size:,} bytes)")
    else:
        print("ℹ️  Training model not found (optional)")
    
    # Check data directory
    wake_word_dir = Path("wake-word/wake-word")
    not_wake_word_dir = Path("wake-word/not-wake-word")
    
    if wake_word_dir.exists():
        positive_count = len(list(wake_word_dir.glob("*.wav")))
        print(f"✅ Positive samples: {positive_count}")
    else:
        print("❌ No positive samples found")
    
    if not_wake_word_dir.exists():
        negative_count = len(list(not_wake_word_dir.glob("*.wav")))
        print(f"✅ Negative samples: {negative_count}")
    else:
        print("❌ No negative samples found")

def main():
    """Main test function"""
    
    print("Finnish Wake Word Model Tester")
    print("=" * 40)
    
    # Show model info
    show_model_info()
    
    # Test model
    success = test_model()
    
    if success:
        print("\n🎉 Model test successful!")
        print("Ready to transfer to Raspberry Pi")
        print("Run: ./transfer-to-pi.sh")
    else:
        print("\n⚠️  Model test inconclusive")
        print("Try running the test again and say 'Eppu' clearly")
    
    # Ask if user wants to test different sensitivities
    response = input("\nTest different sensitivity settings? (y/n): ").lower()
    if response == 'y':
        test_with_different_sensitivity()

if __name__ == "__main__":
    main()
