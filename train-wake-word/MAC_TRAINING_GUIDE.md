# Mac Training Guide for Finnish Wake Word

This guide will help you train the "Hei Eppu" wake phrase model on your Mac and transfer it to your Raspberry Pi.

## Why Train on Mac?

- **Faster training** - Mac has more CPU power than Pi
- **Better audio quality** - Mac microphone is usually better
- **Easier data collection** - More comfortable recording environment
- **Faster iteration** - Quick retraining and testing

## Prerequisites

- Mac with Python 3.7+
- Microphone (built-in or external)
- SSH access to your Raspberry Pi
- Homebrew (recommended)

## Quick Start

1. **Setup on Mac:**
   ```bash
   cd train-wake-word
   ./setup-training.sh
   source venv/bin/activate
   ```

2. **Collect data:**
   ```bash
   python collect-data.py
   ```

3. **Train model:**
   ```bash
   python train-model.py
   ```

4. **Transfer to Pi:**
   ```bash
   ./transfer-to-pi.sh
   ```

## Detailed Steps

### Step 1: Mac Setup

The setup script will automatically detect macOS and install the right dependencies:

```bash
cd train-wake-word
chmod +x setup-training.sh
./setup-training.sh
source venv/bin/activate
```

**What it installs:**
- Python virtual environment
- Precise training tools
- Audio processing libraries
- PortAudio (via Homebrew)

### Step 2: Data Collection

**Interactive Collection:**
```bash
python collect-data.py
```

**Collection Tips for Mac:**
- Use a quiet room
- Speak clearly into the microphone
- Vary your tone and volume
- Record in different positions relative to mic
- Use different emotional tones

**Data Collection Options:**
1. **Manual Recording** - Record yourself saying "Eppu"
2. **TTS Generation** - Generate synthetic samples
3. **Batch Recording** - Record multiple samples quickly

### Step 3: Model Training

**Train the model:**
```bash
python train-model.py
```

**Training Process:**
1. Validates your data
2. Converts audio to correct format
3. Trains the neural network
4. Converts to Pi-optimized format
5. Tests the model

**Expected Training Time:**
- 100 samples: ~2-5 minutes
- 200 samples: ~5-10 minutes
- 500+ samples: ~10-20 minutes

### Step 4: Transfer to Pi

**Automatic Transfer:**
```bash
./transfer-to-pi.sh
```

**Manual Transfer:**
```bash
scp models/hei_eppu.pb pi@your-pi-ip:~/eppunormaali/train-wake-word/models/
```

**What gets transferred:**
- `eppu.pb` - Edge-optimized model for Pi
- `eppu.net` - Training model (optional)

### Step 5: Test on Pi

**SSH into your Pi:**
```bash
ssh pi@your-pi-ip
cd ~/eppunormaali
npm start
```

**Test the wake phrase:**
- Say "Hei Eppu" to activate
- Try voice commands like "Hei Eppu, toista Metallica"

## Mac-Specific Tips

### Audio Setup

**Check your microphone:**
```bash
# List audio devices
python -c "import sounddevice as sd; print(sd.query_devices())"
```

**Test recording:**
```bash
python -c "
import sounddevice as sd
import soundfile as sf
audio = sd.rec(16000, samplerate=16000, channels=1, dtype='int16')
sd.wait()
sf.write('test.wav', audio, 16000)
print('Test recording saved as test.wav')
"
```

### Performance Optimization

**For faster training:**
- Close unnecessary apps
- Use external microphone for better quality
- Record in batches to save time

**For better accuracy:**
- Record in the same environment you'll use on Pi
- Use similar microphone characteristics
- Record at different times of day

### Troubleshooting

**Common Mac Issues:**

1. **"PortAudio not found"**
   ```bash
   brew install portaudio
   ```

2. **"Microphone permission denied"**
   - Go to System Preferences > Security & Privacy > Microphone
   - Allow Terminal/Python to access microphone

3. **"Audio device busy"**
   - Close other audio apps (Zoom, Teams, etc.)
   - Restart Terminal

4. **"Training fails"**
   - Check you have enough data (100+ positive, 200+ negative)
   - Verify audio files are valid WAV format
   - Check disk space (need ~1GB for training)

## Workflow Summary

```bash
# 1. Setup (one time)
cd train-wake-word
./setup-training.sh
source venv/bin/activate

# 2. Collect data (15-30 minutes)
python collect-data.py
# Record 100+ "Hei Eppu" samples
# Record 200+ negative samples

# 3. Train model (5-15 minutes)
python train-model.py

# 4. Transfer to Pi (1-2 minutes)
./transfer-to-pi.sh

# 5. Test on Pi
ssh pi@your-pi-ip
cd ~/eppunormaali
npm start
```

## File Structure After Training

```
train-wake-word/
├── models/
│   ├── hei_eppu.pb          # Pi-optimized model
│   └── hei_eppu.net         # Training model
├── wake-word/
│   ├── wake-word/       # Your "Eppu" samples
│   └── not-wake-word/   # Negative samples
└── venv/                # Python environment
```

## Model Quality Checklist

**Before transferring to Pi:**
- ✅ At least 100 positive samples
- ✅ At least 200 negative samples
- ✅ Model trains without errors
- ✅ Test detection works on Mac
- ✅ Model file is created (`hei_eppu.pb`)

**After transferring to Pi:**
- ✅ Model loads without errors
- ✅ Wake word detection works
- ✅ Voice commands work
- ✅ Good accuracy in your environment

## Advanced: Custom Training

**For better accuracy:**
1. **Collect more data** - 200+ positive samples
2. **Use multiple speakers** - Get friends to record
3. **Record in target environment** - Similar to Pi setup
4. **Iterate and improve** - Retrain with more data

**For different wake words:**
1. Change the wake word in collection script
2. Collect new data
3. Retrain model
4. Transfer to Pi

## Support

**If training fails:**
1. Check audio permissions
2. Verify microphone is working
3. Ensure enough training data
4. Check Python dependencies
5. Review error messages

**If transfer fails:**
1. Check SSH connection to Pi
2. Verify Pi has enough space
3. Check file permissions
4. Test model manually on Pi

Happy training! 🎵
