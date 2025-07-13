import { AppServer, AppSession, PhotoData, AuthenticatedRequest } from '@mentra/sdk';
import { GoogleGenAI, Modality, LiveServerMessage, MediaResolution, Session, Type } from '@google/genai';
import * as dotenv from 'dotenv';
import { MemoryManager } from './memory-manager';

// Type definitions for browser events in Node.js context
interface ErrorEvent {
  message: string;
  error?: any;
}

interface CloseEvent {
  reason?: string;
  code?: number;
}

// Load environment variables
dotenv.config();

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error('PACKAGE_NAME is not set in .env file'); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error('MENTRAOS_API_KEY is not set in .env file'); })();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? (() => { throw new Error('GEMINI_API_KEY is not set in .env file'); })();
const PORT = parseInt(process.env.PORT || '3000');

/**
 * Interface for storing conversation data for webview display
 */
interface ConversationEntry {
  id: string;
  timestamp: number;
  userId: string;
  question: string;
  response: string;
  hasPhoto: boolean;
  photoData?: {
    requestId: string;
    mimeType: string;
    buffer: Buffer;
  };
  processingTime: number;
  status: 'processing' | 'completed' | 'error';
  location?: {
    lat: number;
    lng: number;
    address?: string;
  };
  category?: string;
}

/**
 * Interface for Gemini Live session management
 */
interface LiveSessionState {
  session: Session; // Live session object from @google/genai
  isActive: boolean;
  startTime: number;
  userId: string;
  lastActivity: number;
  responseQueue: LiveServerMessage[];
  // Response buffering for streaming text
  responseBuffer: string;
  responseTimeout: NodeJS.Timeout | null;
  isBuffering: boolean;
}

/**
 * Enhanced Voice Assistant with Gemini Live Integration
 * - One-time wake word detection to start live session
 * - Continuous conversation through Gemini Live
 * - Hardware API calls for photos, TTS, and display
 * - Text responses converted to TTS for glasses
 */
class HeyMentraVoiceAssistantLive extends AppServer {
  private gemini: GoogleGenAI;
  private isProcessingRequest = false;
  
  // Memory & Context Management
  private memoryManager: MemoryManager;
  
  // Gemini Live session management
  private liveSessions: Map<string, LiveSessionState> = new Map();
  private liveSessionTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private readonly LIVE_SESSION_TIMEOUT = 300000; // 5 minutes of inactivity
  
  // Hardware state management (from stable backup)
  private activePhotoRequests: Map<string, boolean> = new Map();
  private lastPhotoTime: Map<string, number> = new Map();
  private activeTTSOperations: Map<string, AbortController> = new Map();
  
  // Wake word detection state
  private listeningStates: Map<string, { 
    isListening: boolean; 
    timestamp: number; 
    session: AppSession; 
    hasLiveSession: boolean;
  }> = new Map();
  
  // WEBVIEW DATA STORAGE (from stable backup)
  private conversations: Map<string, ConversationEntry[]> = new Map();
  private activeUsers: Map<string, { lastActivity: number; sessionId: string }> = new Map();
  private sseClients: Map<string, any> = new Map();

  // Gemini Live configuration - FIXED to match Google API docs exactly
  private readonly GEMINI_LIVE_CONFIG = {
    responseModalities: [Modality.TEXT], // TEXT only - we'll convert to speech via glasses TTS
    mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    systemInstruction: "You are an AI assistant integrated with smart glasses that provides STEP-BY-STEP visual guidance. With every message, you automatically receive a photo of what the user is currently looking at.\n\nYour role is to provide INTERACTIVE, VISUAL-BASED guidance:\n\n**CRITICAL INSTRUCTIONS:**\n1. **ALWAYS analyze the photo first** - describe what you can see to confirm you understand their current situation\n2. **Give ONLY ONE step at a time** - never provide multiple steps or a complete list\n3. **Visual confirmation** - if they say 'I did it' or 'what's next?', look at the new photo to confirm they completed the step correctly before giving the next one\n4. **Acknowledge progress** - always confirm what they accomplished based on the visual evidence\n5. **Correct mistakes** - if the photo shows they did something wrong, gently guide them to fix it\n6. **Be conversational** - keep responses to 1-2 sentences since they'll be spoken aloud\n7. **Wait for confirmation** - always end with asking them to complete the step and say 'what's next?' when done\n\n**Response Format:**\n- First: \"I can see [describe current state from photo]\"\n- Then: \"Great! Now [single next action]\"\n- End: \"Let me know when you've done that!\"\n\n**Example Flow:**\n- User: \"Help me connect Bluetooth\"\n- You: \"I can see your phone's home screen. First, open Settings by tapping the gear icon. Let me know when you've done that!\"\n- User: \"What's next?\"\n- You: \"Perfect! I can see you're in Settings now. Tap on 'Connected devices' or 'Bluetooth'. Let me know when you've done that!\"\n\nProvide guidance like a patient friend who can see exactly what you're looking at and helps you one step at a time.",
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: 'Zephyr',
        }
      }
    },
    contextWindowCompression: {
      triggerTokens: '25600',
      slidingWindow: { targetTokens: '12800' },
    },
    tools: [
      {
        functionDeclarations: [
          {
            name: "take_photo",
            description: "Takes an additional photo using the smart glasses camera (note: photos are automatically taken with each message, but this can capture a specific moment)",
            parameters: {
              type: Type.OBJECT,
              properties: {
                reason: {
                  type: Type.STRING,
                  description: "Why this additional photo is being taken"
                }
              } as any
            }
          } as any,
          {
            name: "show_text",
            description: "Display text on the smart glasses screen for the user to see",
            parameters: {
              type: Type.OBJECT,
              properties: {
                text: {
                  type: Type.STRING,
                  description: "Text to display on the glasses"
                },
                duration: {
                  type: Type.NUMBER,
                  description: "How long to show the text in milliseconds (default: 3000)"
                }
              } as any
            }
          } as any
        ]
      }
    ] as any
  };

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: PORT,
      healthCheck: true,
      cookieSecret: 'hey-mentra-live-assistant-' + Date.now()
    });

    // Initialize Gemini AI
    this.gemini = new GoogleGenAI({apiKey: GEMINI_API_KEY});
    
    // Initialize Memory Manager
    this.memoryManager = new MemoryManager();
    
    // Setup webview routes (from stable backup)
    this.setupWebviewRoutes();
    
    this.logger.info(`🚀 Hey Mentra Voice Assistant with Gemini Live initialized`);
  }

  /**
   * WEBVIEW SETUP - Preserved from stable backup
   */
  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();

    // API endpoint to get conversation history
    app.get('/api/conversations', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const userConversations = this.conversations.get(userId) || [];
      const sanitizedConversations = userConversations.map(conv => ({
        id: conv.id,
        timestamp: conv.timestamp,
        question: conv.question,
        response: conv.response,
        hasPhoto: conv.hasPhoto,
        processingTime: conv.processingTime,
        status: conv.status
      }));

      res.json({
        conversations: sanitizedConversations,
        activeUsers: Array.from(this.activeUsers.keys()).length,
        lastActivity: this.activeUsers.get(userId)?.lastActivity || 0,
        hasLiveSession: this.hasActiveLiveSession(userId)
      });
    });

    // API endpoint to get photo data
    app.get('/api/photo/:conversationId', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      const conversationId = req.params.conversationId;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const userConversations = this.conversations.get(userId) || [];
      const conversation = userConversations.find(conv => conv.id === conversationId);
      
      if (!conversation || !conversation.photoData) {
        res.status(404).json({ error: 'Photo not found' });
        return;
      }

      res.set({
        'Content-Type': conversation.photoData.mimeType,
        'Cache-Control': 'no-cache'
      });
      res.send(conversation.photoData.buffer);
    });

    // Main webview route
    app.get('/webview', async (req: any, res: any) => {
      const html = this.generateWebviewHTML();
      res.send(html);
    });

    // SSE endpoint for real-time updates
    app.get('/api/events', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId || 'anonymous';
      
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      
      this.sseClients.set(userId, res);
      this.logger.info(`📡 SSE client connected for user ${userId}`);
      
      res.write(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`);
      
      req.on('close', () => {
        this.sseClients.delete(userId);
        this.logger.info(`📡 SSE client disconnected for user ${userId}`);
      });
    });
  }

  /**
   * Generate simple webview HTML
   */
  private generateWebviewHTML(): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Hey Mentra Live</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
        .status { padding: 10px; margin: 10px 0; border-radius: 8px; }
        .connected { background: #d4edda; color: #155724; }
        .disconnected { background: #f8d7da; color: #721c24; }
        .conversation { background: white; padding: 15px; margin: 10px 0; border-radius: 8px; }
        .question { font-weight: bold; color: #007bff; }
        .response { margin-top: 10px; }
    </style>
</head>
<body>
    <h1>🎙️ Hey Mentra Live Assistant</h1>
    <div id="status" class="status disconnected">Connecting...</div>
    <div id="conversations"></div>
    
    <script>
                const eventSource = new EventSource('/api/events');
        const statusDiv = document.getElementById('status');
        const conversationsDiv = document.getElementById('conversations');
                
                eventSource.onopen = () => {
            statusDiv.textContent = '✅ Connected to Gemini Live';
            statusDiv.className = 'status connected';
                };
                
                eventSource.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    
            if (data.type === 'conversation-completed') {
                const conv = data.conversation;
                const convDiv = document.createElement('div');
                convDiv.className = 'conversation';
                convDiv.innerHTML = \`
                    <div class="question">👤 \${conv.question}</div>
                    <div class="response">🤖 \${conv.response}</div>
                    <small>⏱️ \${new Date(conv.timestamp).toLocaleTimeString()}</small>
                \`;
                conversationsDiv.insertBefore(convDiv, conversationsDiv.firstChild);
            } else if (data.type === 'live-session-started') {
                statusDiv.textContent = '🎙️ Live session active - speak naturally';
                statusDiv.className = 'status connected';
            } else if (data.type === 'live-session-ended') {
                statusDiv.textContent = '⏸️ Live session ended - say "Hey Mentra" to restart';
                statusDiv.className = 'status disconnected';
                    }
                };
                
                eventSource.onerror = () => {
            statusDiv.textContent = '❌ Connection lost';
            statusDiv.className = 'status disconnected';
        };
    </script>
</body>
</html>`;
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    this.logger.info(`🎙️ Session started for user ${userId} (sessionId: ${sessionId})`);
    
    // Initialize user state (from stable backup)
    this.activePhotoRequests.set(userId, false);
    this.lastPhotoTime.set(userId, 0);
    
    // Initialize listening state for wake word detection
    this.listeningStates.set(userId, { 
      isListening: false, 
      timestamp: 0, 
      session: session,
      hasLiveSession: false
    });
    
    // Initialize webview data
    if (!this.conversations.has(userId)) {
      this.conversations.set(userId, []);
    }
    this.activeUsers.set(userId, { lastActivity: Date.now(), sessionId });
    
    // Show welcome message
    this.showWelcomeMessage(session);

    // Set up transcription listener for wake word detection AND live session input
    session.events.onTranscription((data) => {
      try {
        this.handleTranscription(data, session, userId);
            } catch (error) {
        this.logger.error(`❌ Error in transcription handler for user ${userId}:`, error);
      }
    });

    this.logger.info(`✅ Session setup complete for user ${userId}`);
  }

  /**
   * Handle all transcription - both wake word detection and live session input
   */
  private async handleTranscription(data: any, session: AppSession, userId: string): Promise<void> {
    const spokenText = data.text.toLowerCase().trim();
    const listeningState = this.listeningStates.get(userId);
    
    // Broadcast transcription for real-time display
          if (data.text && data.text.trim()) {
            this.broadcastSSE(userId, {
              type: 'transcription',
              text: data.text,
              isFinal: data.isFinal,
              timestamp: Date.now()
            });
          }
          
    // PRIORITY 1: If user has active live session, send ALL final speech to Gemini Live
    if (this.hasActiveLiveSession(userId) && data.isFinal && spokenText.length > 0) {
      // CHECK FOR STOP WORDS FIRST
      if (this.detectStopWord(spokenText)) {
        this.logger.info(`🛑 Stop word detected for user ${userId}: "${spokenText}"`);
        
        const session = this.listeningStates.get(userId)?.session;
        if (session) {
          await this.speakWithTTS(session, "You're welcome! I'm here whenever you need me. Just say 'Hey Mentra' to start again.", userId);
        }
        
        // Close live session gracefully
        await this.closeLiveSession(userId);
        return;
      }
      
      this.logger.info(`🎤 Processing live session input: "${data.text}"`);
      
      const liveState = this.liveSessions.get(userId);
      if (liveState?.session) {
        try {
          // Update activity timestamp
          liveState.lastActivity = Date.now();
          this.resetLiveSessionTimeout(userId);
          
          // AUTOMATICALLY TAKE PHOTO FOR VISUAL CONTEXT
          this.logger.info(`📸 Auto-capturing photo for visual context...`);
          const photo = await this.safePhotoCapture(session, userId);
          
          if (photo) {
            // Store photo for webview
            const conversationEntry = this.createConversationEntry(userId, data.text, "Processing with visual context...");
            conversationEntry.hasPhoto = true;
            conversationEntry.photoData = {
              requestId: `auto_photo_${Date.now()}`,
              mimeType: photo.mimeType,
              buffer: photo.buffer
            };
            this.addConversationEntry(userId, conversationEntry);
            
            // SAVE TO MEMORY MANAGER with photo
            this.memoryManager.saveConversation({
              timestamp: Date.now(),
              userId: userId,
              question: data.text,
              response: "Processing with visual context...",
              photoAnalysis: "Photo automatically captured for visual context",
              taskType: "live-session",
              stepNumber: undefined,
              isCompleted: false,
              context: `Live session conversation with automatic photo capture`
            }, photo);
            
            // Send BOTH image and text together to Gemini Live for combined context
            const base64Image = photo.buffer.toString('base64');
            
            liveState.session.sendClientContent({
              turns: [{
                role: "user",
                parts: [
                  {
                    inlineData: {
                      mimeType: photo.mimeType,
                      data: base64Image
                    }
                  },
                  {
                    text: `${data.text}\n\n[VISUAL CONTEXT: I just took a photo of what I'm currently looking at. Please analyze this image to understand my current situation and provide step-by-step guidance. If I'm asking for help with something, give me ONLY the next single step based on what you can see. If I said "what's next?" or "I did it", please confirm from the photo that I completed the previous step correctly, then give me the next step. Always describe what you can see first to confirm you understand my current state.]`
                  }
                ]
              }],
              turnComplete: true
            });
            
            this.logger.info(`✅ Sent combined image + text to Gemini Live: "${data.text}"`);
          } else {
            // Fallback: send just text if photo fails
            this.logger.warn(`📸 Photo capture failed, sending text only`);
            liveState.session.sendClientContent({
              turns: [data.text]
            });
          }
          
        } catch (error) {
          this.logger.error(`❌ Failed to send to Gemini Live:`, error);
          await this.handleLiveSessionError(userId, session);
        }
      }
              return;
            }
            
    // PRIORITY 2: Wake word detection (only when no live session is active)
    if (!this.hasActiveLiveSession(userId) && data.isFinal && this.detectWakeWord(spokenText)) {
      this.logger.info(`🎯 Wake word detected for user ${userId}: "${spokenText}"`);
      
      // Start Gemini Live session
      await this.startLiveSession(userId, session);
      return;
    }

    // Log non-wake-word speech when no live session
    if (!this.hasActiveLiveSession(userId) && data.isFinal && spokenText.length > 0) {
      this.logger.debug(`🔇 No wake word detected: "${spokenText}"`);
    }
  }

  /**
   * Start a new Gemini Live session
   */
  private async startLiveSession(userId: string, session: AppSession): Promise<void> {
    try {
      this.logger.info(`🎙️ Starting Gemini Live session for user ${userId}...`);
      
      // Close any existing session
      await this.closeLiveSession(userId);
      
      // Create new live session using the correct API - FIXED model name
      const liveSession = await this.gemini.live.connect({
        model: 'gemini-2.0-flash-live-001', // Updated to use the live model as requested
        callbacks: {
          onopen: () => {
            this.logger.info(`✅ Live session opened for user ${userId}`);
          },
          onmessage: (message: LiveServerMessage) => {
            this.handleLiveMessage(message, userId, session);
          },
          onerror: (error: ErrorEvent) => {
            this.logger.error(`❌ Live session error for user ${userId}:`, error.message);
            this.handleLiveSessionError(userId, session);
          },
          onclose: (event: CloseEvent) => {
            this.logger.info(`🔚 Live session closed for user ${userId}:`, event.reason || 'Unknown reason');
            this.cleanupLiveSession(userId);
          }
        },
        config: this.GEMINI_LIVE_CONFIG
      });
      
      // Store session state with response queue
      const liveState: LiveSessionState = {
        session: liveSession,
        isActive: true,
        startTime: Date.now(),
        userId: userId,
        lastActivity: Date.now(),
        responseQueue: [], // Initialize response queue
        responseBuffer: '', // Initialize response buffer
        responseTimeout: null, // Initialize timeout
        isBuffering: false // Initialize buffering state
      };
      
      this.liveSessions.set(userId, liveState);
      
      // Update listening state
      const listeningState = this.listeningStates.get(userId);
      if (listeningState) {
        listeningState.hasLiveSession = true;
      }
      
      // Set session timeout
      this.resetLiveSessionTimeout(userId);
      
      // Confirm to user
      await this.speakWithTTS(session, "How can I help?", userId);
      
      // Broadcast session started
      this.broadcastSSE(userId, {
        type: 'live-session-started',
        timestamp: Date.now()
      });
      
      this.logger.info(`✅ Gemini Live session started for user ${userId}`);
      
    } catch (error) {
      this.logger.error(`❌ Failed to start Gemini Live session for user ${userId}:`, error);
      await this.speakWithTTS(session, "Sorry, I couldn't start the live session. Please try saying 'Hey Mentra' again.", userId);
    }
  }

  /**
   * Handle messages from Gemini Live session - FIXED to match Google API docs structure
   */
  private async handleLiveMessage(message: LiveServerMessage, userId: string, session: AppSession): Promise<void> {
    try {
      this.logger.debug(`📨 Live message received for user ${userId}:`, JSON.stringify(message, null, 2));
      
      // Update activity
      const liveState = this.liveSessions.get(userId);
      if (liveState) {
        liveState.lastActivity = Date.now();
        liveState.responseQueue.push(message);
        this.resetLiveSessionTimeout(userId);
      }
      
      // Handle tool calls (FIXED to match Google API docs structure)
      if (message.toolCall) {
        this.logger.info(`🔧 Tool call received for user ${userId}:`, message.toolCall);
        
        // Handle function calls
        if (message.toolCall.functionCalls) {
          const functionResponses = [];
          
          for (const functionCall of message.toolCall.functionCalls) {
            this.logger.info(`🔧 Executing function ${functionCall.name} with args:`, functionCall.args);
            
            let result: any;
            try {
              switch (functionCall.name) {
                case 'take_photo':
                  result = await this.handleTakePhotoTool(functionCall.args, userId, session);
                  break;
                  
                case 'show_text':
                  result = await this.handleShowTextTool(functionCall.args, session);
                  break;
                  
                default:
                  result = { error: `Unknown function: ${functionCall.name}` };
              }
              
              this.logger.info(`✅ Function ${functionCall.name} executed successfully:`, result);
              
              functionResponses.push({
                id: functionCall.id,
                name: functionCall.name,
                response: result
              });
              
                } catch (error) {
              this.logger.error(`❌ Error executing function ${functionCall.name}:`, error);
              functionResponses.push({
                id: functionCall.id,
                name: functionCall.name,
                response: { error: `Function execution failed: ${(error as Error).message}` }
              });
            }
          }
          
          // Send tool responses back to Gemini Live (FIXED to match Google API docs)
          if (liveState?.session && functionResponses.length > 0) {
            try {
              this.logger.info(`📤 Sending ${functionResponses.length} tool responses back to Gemini Live`);
              
              liveState.session.sendToolResponse({
                functionResponses: functionResponses
              });
              
              this.logger.info(`✅ Tool responses sent successfully to Gemini Live`);
                } catch (error) {
              this.logger.error(`❌ Failed to send tool responses:`, error);
            }
          }
        }
      }
      
      // Handle serverContent with modelTurn structure (from Google API docs)
      if (message.serverContent?.modelTurn?.parts) {
        for (const part of message.serverContent.modelTurn.parts) {
          // Handle text responses
          if (part.text) {
            await this.handleLiveTextResponse(part.text, userId, session);
          }
          
          // Handle file data (photos, etc.)
          if (part.fileData) {
            this.logger.info(`📁 File received: ${part.fileData.fileUri}`);
          }
          
          // Handle inline data (audio, etc.)
          if (part.inlineData) {
            this.logger.info(`📦 Inline data received: ${part.inlineData.mimeType}`);
          }
        }
      }
      
      // Check if turn is complete
      if (message.serverContent?.turnComplete) {
        this.logger.debug(`✅ Turn complete for user ${userId}`);
      }
      
    } catch (error) {
      this.logger.error(`❌ Error handling live message for user ${userId}:`, error);
    }
  }

  /**
   * Handle text responses from Gemini Live - buffer streaming responses
   */
  private async handleLiveTextResponse(text: string, userId: string, session: AppSession): Promise<void> {
    this.logger.info(`🤖 Live text chunk received for user ${userId}: "${text}"`);
    
    const liveState = this.liveSessions.get(userId);
    if (!liveState) {
      this.logger.warn(`⚠️ No live session found for user ${userId}`);
      return;
    }
    
    // CRITICAL: Cancel any existing TTS immediately to prevent overlapping
    const existingTTSController = this.activeTTSOperations.get(userId);
    if (existingTTSController) {
      this.logger.info(`🗣️ Cancelling existing TTS before processing new response for user ${userId}`);
      existingTTSController.abort();
      this.activeTTSOperations.delete(userId);
    }
    
    // Add text to buffer
    liveState.responseBuffer += text;
    liveState.isBuffering = true;
    
    // Clear existing timeout
    if (liveState.responseTimeout) {
      clearTimeout(liveState.responseTimeout);
    }
    
    // Set new timeout to speak buffered response after 500ms of no new text
    liveState.responseTimeout = setTimeout(async () => {
      const completeResponse = liveState.responseBuffer.trim();
      
      if (completeResponse) {
        this.logger.info(`🤖 Speaking complete buffered response for user ${userId}: "${completeResponse}"`);
        
        // Create conversation entry for webview
        const conversationEntry = this.createConversationEntry(userId, "Live conversation", completeResponse);
        this.addConversationEntry(userId, conversationEntry);
        
        // SAVE COMPLETE CONVERSATION TO MEMORY MANAGER
        this.memoryManager.saveConversation({
          timestamp: Date.now(),
          userId: userId,
          question: "Live conversation response",
          response: completeResponse,
          photoAnalysis: "Response to user interaction with visual context",
          taskType: "live-response",
          stepNumber: undefined,
          isCompleted: false,
          context: `AI response in live session: ${completeResponse.substring(0, 100)}...`
        });
        
        // LIMIT RESPONSE LENGTH FOR TTS to prevent timeouts
        const maxTTSLength = 300; // Limit to ~300 characters for reliable TTS
        let ttsText = completeResponse;
        
        if (completeResponse.length > maxTTSLength) {
          // Find a good break point (sentence end) within the limit
          const truncated = completeResponse.substring(0, maxTTSLength);
          const lastSentenceEnd = Math.max(
            truncated.lastIndexOf('.'),
            truncated.lastIndexOf('!'),
            truncated.lastIndexOf('?')
          );
          
          if (lastSentenceEnd > 100) { // Only truncate if we have a reasonable sentence
            ttsText = truncated.substring(0, lastSentenceEnd + 1);
            this.logger.info(`📝 Truncated response for TTS: ${ttsText.length} chars (was ${completeResponse.length})`);
          } else {
            // Fallback: just truncate at word boundary
            const words = truncated.split(' ');
            ttsText = words.slice(0, -1).join(' ') + '.';
            this.logger.info(`📝 Word-truncated response for TTS: ${ttsText.length} chars`);
          }
        }
        
        // CRITICAL: Double-check no TTS is running before starting new one
        const currentTTSController = this.activeTTSOperations.get(userId);
        if (currentTTSController) {
          this.logger.info(`🗣️ Aborting current TTS before starting new one for user ${userId}`);
          currentTTSController.abort();
          this.activeTTSOperations.delete(userId);
          // Small delay to ensure cleanup
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Convert to speech using enhanced TTS with cancellation
        await this.speakWithTTS(session, ttsText, userId);
        
        // Show FULL text as backup (non-blocking) so user can see complete response
        this.showFeedbackAsync(session, `AI: ${completeResponse}`, 6000);
        
        // Broadcast to webview
        this.broadcastSSE(userId, {
          type: 'conversation-completed',
          conversation: conversationEntry
        });
      }
      
      // Reset buffer
      liveState.responseBuffer = '';
      liveState.isBuffering = false;
      liveState.responseTimeout = null;
      
    }, 500); // Wait 500ms after last text chunk
  }

  /**
   * Handle function calls from Gemini Live
   */
  private async handleLiveFunctionCall(functionCall: any, userId: string, session: AppSession): Promise<void> {
    this.logger.info(`🔧 Live function call for user ${userId}:`, functionCall);
    
    let result: any;
    
    try {
      switch (functionCall.name) {
        case 'take_photo':
          result = await this.handleTakePhotoTool(functionCall.args, userId, session);
          break;
          
        case 'show_text':
          result = await this.handleShowTextTool(functionCall.args, session);
          break;
          
        default:
          result = { error: `Unknown function: ${functionCall.name}` };
      }
      
      // Send function result back to Gemini Live
      const liveState = this.liveSessions.get(userId);
      if (liveState?.session) {
        // This would need to be implemented based on the actual API
        // liveState.session.sendFunctionResponse(functionCall.id, result);
        this.logger.info(`📤 Function result sent back to Gemini Live`);
      }
      
    } catch (error) {
      this.logger.error(`❌ Error executing function ${functionCall.name}:`, (error as Error).message);
    }
  }

  /**
   * Handle take_photo tool call
   */
  private async handleTakePhotoTool(args: any, userId: string, session: AppSession): Promise<any> {
    this.logger.info(`📸 Taking photo for user ${userId}, reason: ${args.reason}`);
    
    const photo = await this.safePhotoCapture(session, userId);
    
    if (photo) {
      // Store photo data for webview
      const conversationEntry = this.createConversationEntry(userId, "Photo taken", "I can see what you're looking at now.");
      conversationEntry.hasPhoto = true;
      conversationEntry.photoData = {
        requestId: `photo_${Date.now()}`,
        mimeType: photo.mimeType,
        buffer: photo.buffer
      };
      this.addConversationEntry(userId, conversationEntry);
      
      // SAVE TO MEMORY MANAGER with photo
      this.memoryManager.saveConversation({
        timestamp: Date.now(),
        userId: userId,
        question: "Photo taken via tool call",
        response: "I can see what you're looking at now.",
        photoAnalysis: args.reason || "Photo taken via tool call",
        taskType: "photo-tool",
        stepNumber: undefined,
        isCompleted: false,
        context: `Photo captured via take_photo tool: ${args.reason || 'no reason specified'}`
      }, photo);
      
      return {
        success: true,
        message: `Photo captured successfully. I can see what you're looking at - ${args.reason || 'analyzing the scene'}.`,
        timestamp: new Date().toISOString(),
        imageSize: `${Math.round(photo.buffer.length / 1024)}KB`
      };
        } else {
      return {
        success: false,
        message: "Failed to capture photo - camera may be unavailable or busy."
      };
    }
  }

  /**
   * Handle show_text tool call
   */
  private async handleShowTextTool(args: any, session: AppSession): Promise<any> {
    try {
      const duration = args.duration || 3000;
      session.layouts.showTextWall(args.text, { durationMs: duration });
      
      return {
        success: true,
        message: `Text displayed: "${args.text}"`
      };
      } catch (error) {
      return {
        success: false,
        message: `Failed to display text: ${(error as Error).message}`
      };
    }
  }

  /**
   * Safe photo capture (from stable backup)
   */
  private async safePhotoCapture(session: AppSession, userId: string): Promise<PhotoData | null> {
    // Check if photo request is already in progress for this user
    if (this.activePhotoRequests.get(userId)) {
      this.logger.warn(`📸 Photo request skipped for user ${userId} - request already in progress`);
      // RESET the flag after a timeout to prevent permanent blocking
      setTimeout(() => {
        this.activePhotoRequests.set(userId, false);
        this.logger.info(`📸 Reset photo request flag for user ${userId} after timeout`);
      }, 3000);
      return null;
    }

    const now = Date.now();
    const lastPhoto = this.lastPhotoTime.get(userId) || 0;
    if (now - lastPhoto < 2000) {
      this.logger.warn(`📸 Photo request skipped for user ${userId} - too soon`);
      return null;
    }

    try {
      this.activePhotoRequests.set(userId, true);
      this.logger.info(`📸 Taking photo for user ${userId}...`);
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const photo = await session.camera.requestPhoto();
      this.lastPhotoTime.set(userId, Date.now());
      
      this.logger.info(`📸 Photo captured successfully for user ${userId}`);
      return photo;
      
    } catch (error) {
      this.logger.warn(`📸 Photo capture failed for user ${userId}:`, error);
      return null;
    } finally {
      // CRITICAL: Always clear the active request flag
      this.activePhotoRequests.set(userId, false);
      this.logger.debug(`📸 Photo request flag cleared for user ${userId}`);
    }
  }

  /**
   * Check if user has active live session
   */
  private hasActiveLiveSession(userId: string): boolean {
    const liveState = this.liveSessions.get(userId);
    return liveState?.isActive === true;
  }

  /**
   * Close live session for user
   */
  private async closeLiveSession(userId: string): Promise<void> {
    const liveState = this.liveSessions.get(userId);
    if (liveState?.session) {
      try {
        liveState.session.close();
      } catch (error) {
        this.logger.warn(`⚠️ Error closing live session for user ${userId}:`, error);
      }
    }
    
    await this.cleanupLiveSession(userId);
  }

  /**
   * Clean up live session state
   */
  private async cleanupLiveSession(userId: string): Promise<void> {
    // Get session state before cleanup
    const liveState = this.liveSessions.get(userId);
    
    // Clear any pending response timeout
    if (liveState?.responseTimeout) {
      clearTimeout(liveState.responseTimeout);
    }
    
    // Clear session state
    this.liveSessions.delete(userId);
    
    // Clear timeout
    const timeout = this.liveSessionTimeouts.get(userId);
    if (timeout) {
      clearTimeout(timeout);
      this.liveSessionTimeouts.delete(userId);
    }
    
    // Update listening state
    const listeningState = this.listeningStates.get(userId);
    if (listeningState) {
      listeningState.hasLiveSession = false;
    }
    
    // Broadcast session ended
    this.broadcastSSE(userId, {
      type: 'live-session-ended',
      timestamp: Date.now()
    });
    
    this.logger.info(`🧹 Live session cleanup complete for user ${userId}`);
  }

  /**
   * Handle live session errors
   */
  private async handleLiveSessionError(userId: string, session: AppSession): Promise<void> {
    this.logger.error(`💥 Live session error for user ${userId}, cleaning up...`);
    
    await this.cleanupLiveSession(userId);
    await this.speakWithTTS(session, "Sorry, the live session encountered an error. Say 'Hey Mentra' to restart.", userId);
  }

  /**
   * Reset live session timeout
   */
  private resetLiveSessionTimeout(userId: string): void {
    // Clear existing timeout
    const existingTimeout = this.liveSessionTimeouts.get(userId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    
    // Set new timeout
    const timeout = setTimeout(async () => {
      this.logger.info(`⏰ Live session timeout for user ${userId}`);
      
      const session = this.listeningStates.get(userId)?.session;
      if (session) {
        await this.speakWithTTS(session, "Live session timed out due to inactivity. Say 'Hey Mentra' to restart.", userId);
      }
      
      await this.closeLiveSession(userId);
    }, this.LIVE_SESSION_TIMEOUT);
    
    this.liveSessionTimeouts.set(userId, timeout);
  }

  /**
   * ENHANCED: TTS with proper cancellation to prevent overlapping speech
   */
  private async speakWithTTS(session: AppSession, text: string, userId: string): Promise<void> {
    // Cancel any existing TTS for this user
    const existingTTSController = this.activeTTSOperations.get(userId);
    if (existingTTSController) {
      this.logger.info(`🗣️ Cancelling existing TTS for user ${userId}`);
      existingTTSController.abort();
    }

    // Create new abort controller for this TTS operation
    const controller = new AbortController();
    this.activeTTSOperations.set(userId, controller);

    const maxRetries = 2;
    
    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Check if cancelled
          if (controller.signal.aborted) {
            this.logger.info(`🗣️ TTS cancelled for user ${userId}`);
            return;
          }

          this.logger.info(`🗣️ TTS attempt ${attempt}/${maxRetries} for user ${userId} (${text.length} chars): "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
          
          // Try TTS with timeout and cancellation - FIXED to match stable version
          const result = await Promise.race([
            session.audio.speak(text),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`TTS timeout attempt ${attempt}`)), 10000)
            ),
            // Add cancellation support
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => reject(new Error('TTS cancelled')));
            })
          ]) as any;
          
          if (controller.signal.aborted) {
            this.logger.info(`🗣️ TTS cancelled during execution for user ${userId}`);
            return;
          }
          
          // FIXED: Properly check result.success like stable version
          if (result.success) {
            this.logger.info(`✅ TTS successful for user ${userId} on attempt ${attempt}`);
            return;
          } else {
            throw new Error(result.error || 'TTS failed');
          }
          
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          if (errorMessage === 'TTS cancelled') {
            this.logger.info(`🗣️ TTS cancelled for user ${userId}`);
            return;
          }
          
          this.logger.warn(`🗣️ TTS attempt ${attempt} failed for user ${userId}: ${errorMessage}`);
          
          if (attempt === maxRetries) {
            this.logger.info(`🗣️ All TTS attempts failed for user ${userId}, showing text only`);
            // Final fallback to text only
            session.layouts.showTextWall(`AI: ${text}`, { durationMs: 8000 });
            return;
          }
          
          // Brief delay before retry, but check for cancellation
          await new Promise(resolve => {
            const timeout = setTimeout(resolve, 300); // Back to 300ms like stable
            controller.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              resolve(undefined);
            });
          });
        }
      }
    } finally {
      // Clean up controller
      this.activeTTSOperations.delete(userId);
    }
  }

  /**
   * Show feedback message asynchronously (non-blocking)
   */
  private showFeedbackAsync(session: AppSession, message: string, durationMs: number): void {
    setImmediate(() => {
      try {
        session.layouts.showTextWall(message, { durationMs });
      } catch (error) {
        this.logger.warn(`⚠️ Failed to show feedback message: ${message}`, error);
      }
    });
  }

  /**
   * Wake word detection (from stable backup)
   */
  private detectWakeWord(text: string): boolean {
    const wakeWords = [
      'hey mentra', 'heyy mentra', 'hey mentraaa', 'hey mentra buddy',
      'he mentra', 'hementra', 'hamentra', 'hai mentra', 'hay mentra',
      'hey mantra', 'hey mentor', 'hey manta', 'hey mental'
    ];
    return wakeWords.some(word => text.includes(word));
  }

  /**
   * Stop word detection - end live sessions gracefully
   */
  private detectStopWord(text: string): boolean {
    const stopWords = [
      'thanks mentra', 'thank you mentra', 'that\'s all for now', 'that\'s all', 'that\'s it', 
      'that\'s enough', 'that\'s fine', 'that\'s good', 'that\'s perfect',
      'thanks', 'thank you', 'bye mentra', 'goodbye mentra', 'see you mentra',
      'done', 'finished', 'complete', 'all done', 'we\'re done', 'i\'m done',
      'bye', 'goodbye', 'see you', 'see ya', 'later', 'catch you later',
      'that\'s all i need', 'that\'s everything', 'nothing else', 'no more',
      'stop', 'end', 'quit', 'exit'
    ];
    return stopWords.some(word => text.includes(word));
  }

  /**
   * Show welcome message
   */
  private showWelcomeMessage(session: AppSession): void {
    try {
      session.layouts.showTextWall("How can I help?");
      this.logger.info(`✅ Welcome message shown`);
    } catch (error) {
      this.logger.warn(`⚠️ Failed to show welcome message:`, error);
    }
  }

  /**
   * Create conversation entry for webview
   */
  private createConversationEntry(userId: string, question: string, response: string): ConversationEntry {
    return {
      id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      userId: userId,
      question: question,
      response: response,
      hasPhoto: false,
      processingTime: 0,
      status: 'completed',
      category: 'Live'
    };
  }

  /**
   * Add conversation entry to user's history
   */
  private addConversationEntry(userId: string, entry: ConversationEntry): void {
    const userConversations = this.conversations.get(userId) || [];
    userConversations.unshift(entry);
    
    // Keep only last 50 conversations
    if (userConversations.length > 50) {
      userConversations.splice(50);
    }
    
    this.conversations.set(userId, userConversations);
  }

  /**
   * Broadcast SSE event
   */
  private broadcastSSE(userId: string, data: any): void {
    const client = this.sseClients.get(userId);
    if (client) {
      try {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        this.logger.warn(`Failed to send SSE to user ${userId}:`, error);
        this.sseClients.delete(userId);
      }
    }
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    this.logger.info(`🎙️ Session stopped for user ${userId}, reason: ${reason}`);
    
    // Clean up live session
    await this.closeLiveSession(userId);
    
    // Clean up other state
    this.activePhotoRequests.delete(userId);
    this.lastPhotoTime.delete(userId);
    this.activeTTSOperations.delete(userId);
    this.listeningStates.delete(userId);
    this.activeUsers.delete(userId);
    
    // Close memory manager on app shutdown
    if (reason === 'shutdown') {
      this.memoryManager.close();
    }
  }
}

// Start the server
const app = new HeyMentraVoiceAssistantLive();
app.start().catch(console.error);