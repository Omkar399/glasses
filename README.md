# Hey Mentra Voice Assistant

A MentraOS app that continuously listens for "Hey Mentra" and responds using AI vision and voice. When triggered, it takes a photo of what you're looking at, sends both the image and your question to Google Gemini AI, and responds using ElevenLabs text-to-speech.

## Features

- 🎙️ **Always Listening**: Continuously monitors for the "Hey Mentra" wake word
- 📸 **Instant Vision**: Automatically captures what you're seeing when triggered
- 🧠 **AI Understanding**: Uses Google Gemini AI to understand both your question and the visual context
- 🗣️ **Natural Voice**: Responds using ElevenLabs text-to-speech with natural-sounding voice
- 👓 **Smart Glasses Integration**: Optimized for MentraOS smart glasses experience
- 📱 **Mobile Webview**: Real-time dashboard showing conversation history and photos
- ⚡ **Real-time Updates**: Live conversation tracking with auto-refresh
- 🖼️ **Photo Gallery**: View and interact with captured moments

## 🌐 Webview Dashboard

The app includes a mobile-optimized React webview accessible at:
- **URL**: `https://fitting-foal-blindly.ngrok-free.app/webview` (or `localhost:3000/webview`)
- **Features**: 
  - Real-time conversation history
  - Photo gallery with full-size viewing
  - Processing time analytics
  - Active user tracking
  - Mobile-responsive design with glassmorphism UI

For detailed webview documentation, see [WEBVIEW_DOCUMENTATION.md](./WEBVIEW_DOCUMENTATION.md).

## Prerequisites

1. **MentraOS Developer Account**: Sign up at [console.mentra.glass](https://console.mentra.glass/)
2. **Google Gemini API Key**: Get one from [Google AI Studio](https://makersuite.google.com/app/apikey)
3. **MentraOS SDK**: The app uses `@mentra/sdk` version 2.0.3 or higher
4. **Node.js/Bun**: For running the development server

## Setup Instructions

### 1. Clone and Install Dependencies

```bash
cd hey-mentra-voice-assistant
bun install  # or npm install
```

### 2. Configure Environment Variables

Copy the example environment file and fill in your API keys:

```bash
cp .env.example .env
```

Edit `.env` with your actual API keys:

```env
PORT=3000
PACKAGE_NAME=com.mentra.voice-assistant
MENTRAOS_API_KEY=your_mentraos_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
```

### 3. Set Permissions in MentraOS Developer Console

In the [MentraOS Developer Console](https://console.mentra.glass/):

1. Go to your app settings
2. Add the following permissions:
   - **MICROPHONE** - For voice transcription
   - **CAMERA** - For taking photos

### 4. Run the App

For development with hot reload:
```bash
bun run dev
```

For production:
```bash
bun run start
```

### 5. Expose Your Local Server

Use ngrok or similar to expose your local server:

```bash
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`) and use it in your MentraOS app configuration.

## How to Use

1. **Launch the App**: Open the app in MentraOS on your smart glasses
2. **Wake the Assistant**: Say "Hey Mentra" 
   - The assistant will respond: "I'm listening, how can I help?"
3. **Ask Your Question**: After hearing the response, ask your question
   - Example: "What am I looking at?"
   - Example: "Can you read this sign?"
   - Example: "Describe this scene"
4. **Get AI Response**: The app will:
   - Take a photo automatically
   - Process your question and the image with Gemini AI
   - Respond with natural-sounding voice

## Interaction Flow

**Two-Stage Siri-like Experience:**

1. **Wake Word**: "Hey Mentra" 
   - **Assistant**: "I'm listening, how can I help?" 🎤
2. **Your Question**: "What do you see?"
   - **Assistant**: *[Takes photo and analyzes]* "I can see..."

**Timeout**: You have 10 seconds to ask your question after the wake word. If no question is asked, the assistant will timeout and you'll need to say "Hey Mentra" again.

## Supported Wake Words

The app recognizes various pronunciations:
- "Hey Mentra"
- "Hi Mentra" 
- "Hey Mantra"
- "Hi Mantra"
- "Hey Menta"
- "Hi Menta"

## Example Interactions

**User**: "Hey Mentra"
**Assistant**: "I'm listening, how can I help?"
**User**: "What's in front of me?"
**Assistant**: *[Takes photo]* "I can see a busy street with several cars and a red traffic light. There appears to be a coffee shop on the left side."

**User**: "Hey Mentra"  
**Assistant**: "I'm listening, how can I help?"
**User**: "Read this menu"
**Assistant**: *[Takes photo]* "This appears to be a restaurant menu featuring Italian dishes. I can see pasta options like spaghetti carbonara and fettuccine alfredo, with prices ranging from $12 to $18."

## Technical Details

### Architecture
- **AppServer**: Extends MentraOS AppServer class
- **Voice Processing**: Uses MentraOS transcription events
- **Vision AI**: Google Gemini 1.5 Flash model for image understanding
- **TTS**: ElevenLabs integration via MentraOS audio manager
- **Concurrency**: Prevents multiple simultaneous requests

### Wake Word Detection
- Uses simple string matching with multiple variants
- Processes only final transcriptions to avoid false triggers
- Extracts questions after wake word detection

### Error Handling
- Graceful failure for API errors
- User feedback for processing states
- Prevents concurrent request processing

## Development

### File Structure
```
hey-mentra-voice-assistant/
├── src/
│   └── index.ts          # Main application logic
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── .env.example          # Environment variables template
├── .env                  # Your actual environment variables
└── README.md             # This file
```

### Key Dependencies
- `@mentra/sdk`: MentraOS SDK for glasses integration
- `@google/generative-ai`: Google Gemini AI SDK
- `dotenv`: Environment variable management

## Troubleshooting

### Connection Issues

**"Connection timeout after 5000ms"**
- This is a common WebSocket connection issue. The app now includes enhanced connection settings:
  - Increased reconnection attempts (5 instead of 3)
  - Longer reconnection delays (2000ms instead of 1000ms)
  - Better error handling and recovery
- **Solutions:**
  1. **Check your internet connection** - Ensure stable connectivity
  2. **Verify WebSocket URL** - Add `MENTRAOS_WEBSOCKET_URL=wss://prod.augmentos.cloud/app-ws` to your `.env` file
  3. **Restart the app** - Sometimes a fresh start resolves connection issues
  4. **Check firewall settings** - Ensure WebSocket connections are allowed
  5. **Try local development** - Use `MENTRAOS_WEBSOCKET_URL=ws://localhost:8002/app-ws` for local testing

**"WebSocket connection error"**
- The app now includes automatic retry logic and connection monitoring
- Check the logs for specific error messages
- Ensure your MentraOS API key is valid and active

### Common Issues

1. **"PACKAGE_NAME is not set"**
   - Make sure you've copied `.env.example` to `.env` and filled in the values

2. **"Permission denied for microphone"**
   - Add MICROPHONE permission in the MentraOS Developer Console

3. **"Permission denied for camera"**
   - Add CAMERA permission in the MentraOS Developer Console

4. **Gemini API errors**
   - Verify your Gemini API key is correct
   - Check your Google Cloud billing account is set up

5. **Voice not responding**
   - Ensure ElevenLabs TTS is configured in your MentraOS environment
   - Check your internet connection

### Enhanced Connection Configuration

The app now includes several improvements for connection reliability:

- **Automatic Reconnection**: Up to 5 attempts with exponential backoff
- **Connection Monitoring**: Real-time WebSocket state tracking
- **Error Recovery**: Automatic state cleanup on connection issues
- **Retry Logic**: Enhanced retry mechanisms for all operations
- **Timeout Management**: Optimized timeouts for better reliability

### Environment Variables

Add these to your `.env` file for enhanced configuration:

```env
PORT=3000
PACKAGE_NAME=com.mentra.voice-assistant
MENTRAOS_API_KEY=your_mentraos_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here

# Optional: Override the default MentraOS WebSocket URL
# Default: wss://prod.augmentos.cloud/app-ws
# For local development: ws://localhost:8002/app-ws
MENTRAOS_WEBSOCKET_URL=wss://prod.augmentos.cloud/app-ws
```

### Debug Mode

Add debug logging by setting log level:
```typescript
this.logger.setLevel('debug');
```

## License

MIT License - Feel free to modify and use this code for your own MentraOS applications.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests. 