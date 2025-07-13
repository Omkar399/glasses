# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a MentraOS voice assistant app that continuously listens for "Hey Mentra" and responds using AI vision and voice. The app integrates with Google Gemini AI for image understanding and includes a real-time React webview dashboard.

## Development Commands

- **Start development**: `bun run dev` (with hot reload)
- **Start production**: `bun run start` 
- **Build TypeScript**: `bun run build` (compiles to ./dist)
- **Install dependencies**: `bun install`

No test suite is currently configured - tests directory would need to be created.

## Environment Setup

Copy `.env.example` to `.env` and configure:
- `MENTRAOS_API_KEY`: MentraOS developer console API key
- `GEMINI_API_KEY`: Google Gemini AI API key  
- `PACKAGE_NAME`: MentraOS app package identifier
- `PORT`: Server port (default 3000)

## Architecture Overview

### Core App Structure
- **Main Class**: `HeyMentraVoiceAssistant` extends MentraOS `AppServer`
- **Single File**: All logic contained in `src/index.ts` (~965 lines)
- **Framework**: Uses MentraOS SDK v2.0.3+ with Google Gemini AI integration

### Key Components

**Voice Processing Pipeline**:
1. Wake word detection ("Hey Mentra", "Hi Mentra", "Hey Mantra")
2. Question extraction from transcription
3. Parallel photo capture + text-only AI processing
4. Vision AI processing if photo available, fallback to text-only
5. Text-to-speech response with retry logic

**Webview System**:
- Real-time React dashboard at `/webview` endpoint
- Conversation history with photos at `/api/conversations`
- Photo serving at `/api/photo/:conversationId`
- Mobile-optimized UI with glassmorphism design
- Auto-refresh every 3 seconds

**Data Storage** (in-memory):
- `conversations: Map<userId, ConversationEntry[]>` - conversation history per user
- `activeUsers: Map<userId, {lastActivity, sessionId}>` - active user tracking
- Limited to 50 conversations per user for memory management

### Key Patterns

**Async Processing**:
- Queue-based request processing prevents concurrent operations
- Promise.allSettled for parallel photo+text processing
- Retry mechanisms for AI API calls and TTS
- Non-blocking operations using setImmediate()

**Error Handling**:
- Graceful fallbacks: Vision AI → Text-only → Default responses
- Retry logic with exponential backoff
- Safe photo capture with user-specific timing controls

**MentraOS Integration**:
- Session lifecycle management (onSession/onStop)
- Camera permission handling
- Audio/TTS integration with fallback to text display
- Button press handling for testing (long press triggers test mode)
- **Note**: Authentication check for /webview endpoint is currently disabled (commented out)

## Key Dependencies

- `@mentra/sdk`: MentraOS SDK for smart glasses integration
- `@google/generative-ai`: Google Gemini AI for vision and text processing
- `dotenv`: Environment variable management
- Built-in Express server for webview functionality

## Development Workflow

1. Configure MentraOS permissions (MICROPHONE, CAMERA) in developer console
2. Set up ngrok or similar tunnel for local development
3. Test wake word detection and AI responses
4. Monitor webview dashboard for real-time conversation tracking
5. Use button presses for testing (long press = test mode, short press = status)

## Important Implementation Notes

- Photo capture has 2-second minimum intervals per user
- Large images (>1MB base64) automatically fall back to text-only processing  
- Conversation data is isolated per userId for security
- ~~All webview endpoints require MentraOS authentication~~ **Webview authentication is currently disabled for testing** (lines 129-143 commented out)
- Processing queue ensures only one request per session at a time
- Extensive logging for debugging wake word detection and AI processing