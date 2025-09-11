#!/bin/bash

# Setup script for training Finnish wake word "Eppu"
# Works on both Mac and Raspberry Pi

echo "Setting up wake word training environment..."

# Detect operating system
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Detected macOS"
    PLATFORM="mac"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "Detected Linux"
    PLATFORM="linux"
else
    echo "Unsupported operating system: $OSTYPE"
    exit 1
fi

# Create virtual environment
echo "Creating Python virtual environment..."
python3 -m venv venv
source venv/bin/activate

# Install dependencies
echo "Installing training dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

# Install system dependencies based on platform
if [[ "$PLATFORM" == "mac" ]]; then
    echo "Installing macOS audio dependencies..."
    # Install portaudio via homebrew if available
    if command -v brew &> /dev/null; then
        brew install portaudio
    else
        echo "Homebrew not found. Please install portaudio manually:"
        echo "  brew install portaudio"
    fi
elif [[ "$PLATFORM" == "linux" ]]; then
    echo "Installing Linux audio dependencies..."
    sudo apt-get update
    sudo apt-get install -y portaudio19-dev python3-pyaudio
fi

# Create directories
echo "Creating data directories..."
mkdir -p wake-word/wake-word
mkdir -p wake-word/not-wake-word
mkdir -p models

# Make scripts executable
chmod +x collect-data.py
chmod +x train-model.py

echo "Setup complete!"
echo ""
echo "Platform: $PLATFORM"
echo "Next steps:"
echo "1. Activate virtual environment: source venv/bin/activate"
echo "2. Collect data: python collect-data.py"
echo "3. Train model: python train-model.py"
echo ""
if [[ "$PLATFORM" == "mac" ]]; then
    echo "Mac training workflow:"
    echo "4. Transfer model to Pi: ./transfer-to-pi.sh"
    echo "5. Test on Pi: npm start"
else
    echo "Pi training workflow:"
    echo "4. Test model: precise-listen models/eppu.pb"
    echo "5. Start bot: npm start"
fi
echo ""
echo "Data collection tips:"
echo "- Record 'Eppu' in different tones and volumes"
echo "- Collect at least 100 positive samples"
echo "- Collect at least 200 negative samples"
echo "- Use different speakers if possible"
