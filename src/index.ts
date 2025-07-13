import { AppServer, AppSession, PhotoData, AuthenticatedRequest } from '@mentra/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';

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
}

/**
 * SUPER OPTIMIZED Voice Assistant App with Enhanced Async/Await + WEBVIEW
 * - Robust promise handling with retries
 * - Non-blocking asynchronous operations
 * - Fail-safe async patterns
 * - Mobile-optimized React webview integration
 * - Real-time conversation data display
 */
class HeyMentraVoiceAssistant extends AppServer {
  private gemini: GoogleGenerativeAI;
  private isProcessingRequest = false;
  private requestQueue: Array<{ question: string; session: AppSession; userId: string; timestamp: number }> = [];
  private activePhotoRequests: Map<string, boolean> = new Map(); // Track active photo requests per user
  private lastPhotoTime: Map<string, number> = new Map(); // Track last photo time per user
  
  // WEBVIEW DATA STORAGE
  private conversations: Map<string, ConversationEntry[]> = new Map(); // Store conversations by userId
  private activeUsers: Map<string, { lastActivity: number; sessionId: string }> = new Map(); // Track active users

  // TWO-STAGE INTERACTION STATE
  private listeningStates: Map<string, { 
    isListening: boolean; 
    timestamp: number; 
    session: AppSession; 
  }> = new Map(); // Track listening state per user
  private readonly LISTENING_TIMEOUT = 10000; // 10 seconds to ask question after wake word

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: PORT,
      // Enhanced server configuration for better reliability
      healthCheck: true,
      cookieSecret: 'hey-mentra-voice-assistant-secret-key-' + Date.now()
    });

    // Initialize Gemini AI
    this.gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
    
    // Setup webview routes
    this.setupWebviewRoutes();
    
    this.logger.info(`🚀 OPTIMIZED Hey Mentra Voice Assistant with ENHANCED CONNECTION SETTINGS initialized`);
  }

  /**
   * WEBVIEW SETUP - Mobile-optimized React UI served directly from index.ts
   */
  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();

    // API endpoint to get conversation history for authenticated user
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
        lastActivity: this.activeUsers.get(userId)?.lastActivity || 0
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

    // Main webview route - serves React UI
    app.get('/webview', async (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      if (!userId) {
        res.status(401).send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Hey Mentra - Not Authenticated</title>
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: white;">
              <h1>🔒 Please open this page from the MentraOS app</h1>
            </body>
          </html>
        `);
        return;
      }

      // Serve the React-based mobile UI
      const html = this.generateReactWebviewHTML();
      res.send(html);
    });
  }

  /**
   * Generate mobile-optimized React UI HTML (all-in-one file approach)
   */
  private generateReactWebviewHTML(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hey Mentra - Voice Assistant</title>
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
            overflow-x: hidden;
        }
        
        .container {
            max-width: 100%;
            padding: 20px;
            min-height: 100vh;
        }
        
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding: 20px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        
        .logo {
            font-size: 2.5rem;
            font-weight: bold;
            margin-bottom: 10px;
            background: linear-gradient(45deg, #fff, #f0f0f0);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .status {
            display: flex;
            justify-content: space-between;
            margin: 20px 0;
            gap: 10px;
        }
        
        .status-card {
            flex: 1;
            padding: 15px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            text-align: center;
            backdrop-filter: blur(10px);
        }
        
        .conversation-list {
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        
        .conversation-item {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            padding: 20px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            transition: all 0.3s ease;
        }
        
        .conversation-item:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
        }
        
        .conversation-header {
            display: flex;
            justify-content: between;
            align-items: center;
            margin-bottom: 15px;
        }
        
        .timestamp {
            font-size: 0.9rem;
            opacity: 0.7;
        }
        
        .status-badge {
            padding: 5px 12px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: bold;
        }
        
        .status-completed { background: #4CAF50; }
        .status-processing { background: #FF9800; }
        .status-error { background: #F44336; }
        
        .question {
            font-weight: bold;
            margin-bottom: 10px;
            color: #FFE082;
        }
        
        .response {
            line-height: 1.6;
            margin-bottom: 15px;
        }
        
        .photo-container {
            margin-top: 15px;
        }
        
        .photo {
            width: 100%;
            max-width: 300px;
            border-radius: 15px;
            cursor: pointer;
            transition: transform 0.3s ease;
        }
        
        .photo:hover {
            transform: scale(1.05);
        }
        
        .processing-time {
            font-size: 0.8rem;
            opacity: 0.7;
            text-align: right;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
        }
        
        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid rgba(255, 255, 255, 0.3);
            border-top: 4px solid white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            opacity: 0.7;
        }
        
        .refresh-btn {
            position: fixed;
            bottom: 30px;
            right: 30px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: linear-gradient(45deg, #FF6B6B, #4ECDC4);
            border: none;
            color: white;
            font-size: 1.5rem;
            cursor: pointer;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.3);
            transition: all 0.3s ease;
        }
        
        .refresh-btn:hover {
            transform: scale(1.1);
        }
        
        @media (max-width: 768px) {
            .container { padding: 15px; }
            .status { flex-direction: column; }
            .logo { font-size: 2rem; }
        }
    </style>
</head>
<body>
    <div id="root"></div>

    <script type="text/babel">
        const { useState, useEffect } = React;

        function App() {
            const [conversations, setConversations] = useState([]);
            const [loading, setLoading] = useState(true);
            const [stats, setStats] = useState({ activeUsers: 0, lastActivity: 0 });

            const fetchData = async () => {
                try {
                    const response = await fetch('/api/conversations');
                    const data = await response.json();
                    setConversations(data.conversations || []);
                    setStats({ 
                        activeUsers: data.activeUsers || 0, 
                        lastActivity: data.lastActivity || 0 
                    });
                } catch (error) {
                    console.error('Failed to fetch conversations:', error);
                } finally {
                    setLoading(false);
                }
            };

            useEffect(() => {
                fetchData();
                const interval = setInterval(fetchData, 3000); // Auto-refresh every 3 seconds
                return () => clearInterval(interval);
            }, []);

            const formatTime = (timestamp) => {
                return new Date(timestamp).toLocaleTimeString();
            };

            const formatDuration = (ms) => {
                return \`\${(ms / 1000).toFixed(1)}s\`;
            };

            if (loading) {
                return (
                    <div className="container">
                        <div className="loading">
                            <div className="spinner"></div>
                            <p>Loading conversations...</p>
                        </div>
                    </div>
                );
            }

            return (
                <div className="container">
                    <div className="header">
                        <div className="logo">👓 Hey Mentra</div>
                        <p>Voice Assistant Dashboard</p>
                    </div>

                    <div className="status">
                        <div className="status-card">
                            <div style={{fontSize: '1.5rem', fontWeight: 'bold'}}>{conversations.length}</div>
                            <div>Conversations</div>
                        </div>
                        <div className="status-card">
                            <div style={{fontSize: '1.5rem', fontWeight: 'bold'}}>{stats.activeUsers}</div>
                            <div>Active Users</div>
                        </div>
                        <div className="status-card">
                            <div style={{fontSize: '1.5rem', fontWeight: 'bold'}}>
                                {stats.lastActivity ? formatTime(stats.lastActivity) : '--'}
                            </div>
                            <div>Last Activity</div>
                        </div>
                    </div>

                    <div className="conversation-list">
                        {conversations.length === 0 ? (
                            <div className="empty-state">
                                <h3>🎙️ No conversations yet</h3>
                                <p>Start talking to your Mentra glasses!</p>
                                <p>Say "Hey Mentra" + your question</p>
                            </div>
                        ) : (
                            conversations.map(conv => (
                                <div key={conv.id} className="conversation-item">
                                    <div className="conversation-header">
                                        <span className="timestamp">{formatTime(conv.timestamp)}</span>
                                        <span className={\`status-badge status-\${conv.status}\`}>
                                            {conv.status}
                                        </span>
                                    </div>
                                    
                                    <div className="question">
                                        🎤 "{conv.question}"
                                    </div>
                                    
                                    <div className="response">
                                        🤖 {conv.response}
                                    </div>
                                    
                                    {conv.hasPhoto && (
                                        <div className="photo-container">
                                            <img 
                                                src={\`/api/photo/\${conv.id}\`}
                                                alt="Captured moment"
                                                className="photo"
                                                onClick={() => window.open(\`/api/photo/\${conv.id}\`, '_blank')}
                                            />
                                        </div>
                                    )}
                                    
                                    <div className="processing-time">
                                        ⚡ Processed in {formatDuration(conv.processingTime)}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    <button className="refresh-btn" onClick={fetchData} title="Refresh">
                        🔄
                    </button>
                </div>
            );
        }

        ReactDOM.render(<App />, document.getElementById('root'));
    </script>
</body>
</html>`;
  }

  /**
   * Override to create AppSession with enhanced connection settings
   */
  protected createAppSession(userId: string): any {
    const { AppSession } = require('@mentra/sdk');
    
    // Enhanced WebSocket configuration
    const sessionConfig = {
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      userId: userId,
      appServer: this,
      // Enhanced connection settings
      mentraOSWebsocketUrl: process.env.MENTRAOS_WEBSOCKET_URL || 'wss://prod.augmentos.cloud/app-ws',
      autoReconnect: true,
      maxReconnectAttempts: 5,  // Increase from default 3 to 5
      reconnectDelay: 2000      // Increase from default 1000ms to 2000ms
    };

    this.logger.info(`🔧 Creating enhanced AppSession for user ${userId} with config:`, {
      websocketUrl: sessionConfig.mentraOSWebsocketUrl,
      autoReconnect: sessionConfig.autoReconnect,
      maxReconnectAttempts: sessionConfig.maxReconnectAttempts,
      reconnectDelay: sessionConfig.reconnectDelay
    });

    return new AppSession(sessionConfig);
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    this.logger.info(`🎙️ Session started for user ${userId} (sessionId: ${sessionId})`);
    
    // Enhanced connection monitoring and error handling
    this.setupConnectionMonitoring(session, userId);
    
    // Initialize user state
    this.activePhotoRequests.set(userId, false);
    this.lastPhotoTime.set(userId, 0);
    
    // Initialize listening state for two-stage interaction
    this.listeningStates.set(userId, { 
      isListening: false, 
      timestamp: 0, 
      session: session 
    });
    
    // WEBVIEW: Initialize user conversation storage and track active user
    if (!this.conversations.has(userId)) {
      this.conversations.set(userId, []);
    }
    this.activeUsers.set(userId, { lastActivity: Date.now(), sessionId });
    
    // Show welcome message with retry (non-blocking)
    setImmediate(async () => {
      await this.showWelcomeWithRetry(session, userId);
    });

    // Set up button press listener for testing (like camera stream example)
    try {
      session.events.onButtonPress((button) => {
        this.logger.info(`🔘 Button pressed by user ${userId}: ${button.buttonId}, type: ${button.pressType}`);
        
        if (button.pressType === 'long') {
          // Long press - trigger a test question
          this.logger.info(`🧪 Test mode triggered by user ${userId}`);
          setImmediate(async () => {
            try {
              await this.processRequest("what do you see", session, userId);
            } catch (error) {
              this.logger.error(`❌ Failed to process test request for user ${userId}:`, error);
            }
          });
        } else {
          // Short press - show status
          this.showFeedbackAsync(session, "Voice assistant is ready. Say 'Hey Mentra' to start...", 3000);
        }
      });
      
      this.logger.info(`✅ Button listener set up successfully for user ${userId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to set up button listener for user ${userId}:`, error);
    }

    // Set up transcription listener with two-stage interaction and enhanced error handling
    try {
      session.events.onTranscription((data) => {
        try {
          this.logger.debug(`🎤 Transcription received for user ${userId}: isFinal=${data.isFinal}, text="${data.text}"`);
          
          if (!data.isFinal) return;

          const spokenText = data.text.toLowerCase().trim();
          this.logger.info(`🎤 Final transcription for user ${userId}: "${spokenText}"`);
          
          const listeningState = this.listeningStates.get(userId);
          
          // Check if we're in listening mode (waiting for user question)
          if (listeningState?.isListening) {
            const timeSinceWakeWord = Date.now() - listeningState.timestamp;
            
            if (timeSinceWakeWord > this.LISTENING_TIMEOUT) {
              // Timeout - reset listening state
              this.logger.info(`⏰ Listening timeout for user ${userId}`);
              this.resetListeningState(userId);
              this.showFeedbackAsync(session, "Listening timeout. Say 'Hey Mentra' to try again.", 3000);
              return;
            }
            
            // Process the user's question
            this.logger.info(`✨ Processing user question for ${userId}: "${spokenText}"`);
            this.resetListeningState(userId);
            
            // Update last activity for webview
            this.activeUsers.set(userId, { lastActivity: Date.now(), sessionId });
            
            // Process the question
            setImmediate(async () => {
              try {
                await this.processRequest(spokenText, session, userId);
              } catch (error) {
                this.logger.error(`❌ Failed to process request for user ${userId}:`, error);
              }
            });
          } else {
            // Check for wake word detection
            if (this.detectWakeWord(spokenText)) {
              this.logger.info(`✨ Wake word detected for user ${userId}`);
              
              // Enter listening mode
              this.listeningStates.set(userId, {
                isListening: true,
                timestamp: Date.now(),
                session: session
              });
              
              // Update last activity for webview
              this.activeUsers.set(userId, { lastActivity: Date.now(), sessionId });
              
              // Respond with "I'm listening" message with retry
              setImmediate(async () => {
                await this.speakWithRetry(session, "I'm listening, how can I help?", userId);
                this.showFeedbackAsync(session, "🎤 I'm listening, how can I help?", 8000);
              });
              
              // Set timeout to reset listening state
              setTimeout(() => {
                const currentState = this.listeningStates.get(userId);
                if (currentState?.isListening && currentState.timestamp === this.listeningStates.get(userId)?.timestamp) {
                  this.logger.info(`⏰ Auto-resetting listening state for user ${userId}`);
                  this.resetListeningState(userId);
                }
              }, this.LISTENING_TIMEOUT);
              
            } else {
              this.logger.debug(`🔇 No wake word detected in: "${spokenText}"`);
            }
          }
        } catch (error) {
          this.logger.error(`❌ Error in transcription handler for user ${userId}:`, error);
        }
      });
      
      this.logger.info(`✅ Transcription listener set up successfully for user ${userId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to set up transcription listener for user ${userId}:`, error);
    }
  }

  /**
   * Enhanced connection monitoring and error handling
   */
  private setupConnectionMonitoring(session: AppSession, userId: string): void {
    try {
      // Monitor connection state
      session.events.onConnected(() => {
        this.logger.info(`✅ WebSocket connected for user ${userId}`);
      });

      session.events.onDisconnected(() => {
        this.logger.warn(`⚠️ WebSocket disconnected for user ${userId}`);
        // Clean up user state on disconnect
        this.resetListeningState(userId);
      });

      session.events.onError((error) => {
        this.logger.error(`❌ WebSocket error for user ${userId}:`, error);
        // Attempt to recover by resetting listening state
        this.resetListeningState(userId);
      });

      this.logger.info(`✅ Connection monitoring set up for user ${userId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to set up connection monitoring for user ${userId}:`, error);
    }
  }

  /**
   * Show welcome message with retry logic
   */
  private async showWelcomeWithRetry(session: AppSession, userId: string): Promise<void> {
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        session.layouts.showTextWall("Hey Mentra is ready! Say 'Hey Mentra' to start.");
        this.logger.info(`✅ Welcome message shown for user ${userId} (attempt ${attempt})`);
        return;
      } catch (error) {
        this.logger.warn(`⚠️ Welcome message attempt ${attempt} failed for user ${userId}:`, error);
        
        if (attempt === maxRetries) {
          this.logger.error(`❌ All welcome message attempts failed for user ${userId}`);
        } else {
          // Brief delay before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  /**
   * Enhanced TTS with retry specifically for wake word responses
   */
  private async speakWithRetry(session: AppSession, message: string, userId: string): Promise<void> {
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`🗣️ TTS attempt ${attempt}/${maxRetries} for user ${userId}: "${message}"`);
        
        const result = await Promise.race([
          session.audio.speak(message),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`TTS timeout attempt ${attempt}`)), 8000)
          )
        ]) as any;
        
        if (result.success) {
          this.logger.info(`✅ TTS successful for user ${userId} on attempt ${attempt}`);
          return;
        } else {
          throw new Error(result.error || 'TTS failed');
        }
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`🗣️ TTS attempt ${attempt} failed for user ${userId}: ${errorMessage}`);
        
        if (attempt === maxRetries) {
          this.logger.info(`🗣️ All TTS attempts failed for user ${userId}, using text fallback`);
          return;
        }
        
        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    // Clean up user state
    this.activePhotoRequests.delete(userId);
    this.lastPhotoTime.delete(userId);
    
    // WEBVIEW: Remove from active users but keep conversation history
    this.activeUsers.delete(userId);
    
    this.logger.info(`🎙️ Session stopped for user ${userId}, reason: ${reason}`);
  }

  /**
   * ENHANCED: Async queue-based request processing with WEBVIEW data storage
   */
  private async processRequest(question: string, session: AppSession, userId: string): Promise<void> {
    // Add to queue
    this.requestQueue.push({ question, session, userId, timestamp: Date.now() });
    
    // Process if not already processing (non-blocking)
    if (!this.isProcessingRequest) {
      await this.processQueueAsync();
    }
  }

  /**
   * ENHANCED: Fully async queue processing with webview data storage
   */
  private async processQueueAsync(): Promise<void> {
    if (this.requestQueue.length === 0 || this.isProcessingRequest) return;
    
    this.isProcessingRequest = true;
    const request = this.requestQueue.shift()!;
    
    // WEBVIEW: Create conversation entry
    const conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    const conversationEntry: ConversationEntry = {
      id: conversationId,
      timestamp: startTime,
      userId: request.userId,
      question: request.question,
      response: '',
      hasPhoto: false,
      processingTime: 0,
      status: 'processing'
    };
    
    // Add to user's conversation list
    const userConversations = this.conversations.get(request.userId) || [];
    userConversations.unshift(conversationEntry); // Add to beginning for latest-first display
    this.conversations.set(request.userId, userConversations);
    
    // Keep only last 50 conversations per user to prevent memory issues
    if (userConversations.length > 50) {
      userConversations.splice(50);
    }
    
    try {
      // Show immediate feedback (non-blocking)
      this.showFeedbackAsync(request.session, "Processing...", 1000);
      
      // ENHANCED PARALLEL PROCESSING with better promise handling
      const parallelOperations = await this.executeParallelOperations(request, request.userId);
      
      // Process results with fallback chain
      const finalResponse = await this.processResults(parallelOperations, request.question, conversationEntry);
      
      // Update conversation entry with results
      conversationEntry.response = finalResponse;
      conversationEntry.processingTime = Date.now() - startTime;
      conversationEntry.status = 'completed';
      
      // ENHANCED TTS with retry mechanism
      await this.speakResponseWithRetry(request.session, finalResponse);
      
    } catch (error) {
      this.logger.error(`❌ Request failed:`, error);
      
      // Update conversation entry with error
      conversationEntry.response = "Sorry, I encountered an error. Please try again.";
      conversationEntry.processingTime = Date.now() - startTime;
      conversationEntry.status = 'error';
      
      // Async error response (non-blocking)
      setImmediate(async () => {
        await this.speakResponseWithRetry(request.session, "Sorry, please try again.");
      });
    } finally {
      this.isProcessingRequest = false;
      
      // Process next item in queue (non-blocking)
      if (this.requestQueue.length > 0) {
        setImmediate(() => this.processQueueAsync());
      }
    }
  }

  /**
   * ENHANCED: Execute parallel operations with better promise management
   */
  private async executeParallelOperations(request: { question: string; session: AppSession; userId: string; timestamp: number }, userId: string) {
    // Create promises that won't reject the entire Promise.allSettled
    const photoPromise = this.safePhotoCapture(request.session, userId);
    const textPromise = this.safeTextOnlyProcessing(request.question);
    
    // Execute in parallel with proper error isolation
    return await Promise.allSettled([photoPromise, textPromise]);
  }

  /**
   * ENHANCED: Safe photo capture with stable implementation (based on camera_stream_example)
   */
  private async safePhotoCapture(session: AppSession, userId: string): Promise<PhotoData | null> {
    // Check if photo request is already in progress for this user
    if (this.activePhotoRequests.get(userId)) {
      this.logger.warn(`📸 Photo request skipped for user ${userId} - request already in progress`);
      return null;
    }

    // Check minimum time interval (2 seconds like camera stream example)
    const now = Date.now();
    const lastPhoto = this.lastPhotoTime.get(userId) || 0;
    if (now - lastPhoto < 2000) {
      this.logger.warn(`📸 Photo request skipped for user ${userId} - too soon (${now - lastPhoto}ms since last photo)`);
      return null;
    }

    try {
      // Mark photo request as active
      this.activePhotoRequests.set(userId, true);
      this.logger.info(`📸 Taking photo for user ${userId}...`);
      
      // Small delay to let camera settle (like camera stream example does with async)
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const photo = await session.camera.requestPhoto();
      
      // Update last photo time
      this.lastPhotoTime.set(userId, Date.now());
      
      this.logger.info(`📸 Photo captured successfully for user ${userId}`);
      return photo;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`📸 Photo capture failed for user ${userId}: ${errorMessage}`);
      return null;
    } finally {
      // Always clear the active request flag
      this.activePhotoRequests.set(userId, false);
    }
  }

  /**
   * ENHANCED: Safe text-only processing with retry
   */
  private async safeTextOnlyProcessing(question: string): Promise<string> {
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`🤖 Text processing attempt ${attempt}/${maxRetries}`);
        
        const model = this.gemini.getGenerativeModel({ 
          model: "gemini-2.5-flash-lite-preview-06-17",
          generationConfig: {
            maxOutputTokens: 500,
            temperature: 0.7
          }
        });

        const prompt = `Smart glasses AI assistant. User asked: "${question}". 
Give a helpful 1-sentence response. Be conversational for text-to-speech.`;

        const result = await Promise.race([
          model.generateContent([prompt]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Gemini timeout attempt ${attempt}`)), 6000)
          )
        ]) as any;
        
        const response = await result.response;
        const text = response.text();
        
        if (text && text.trim().length > 0) {
          return text;
        }
        
        throw new Error('Empty response from Gemini');
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`🤖 Text processing attempt ${attempt} failed: ${errorMessage}`);
        
        if (attempt === maxRetries) {
          return "I'm ready to help! What would you like to know?";
        }
        
        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return "I'm here to help! Could you repeat your question?";
  }

  /**
   * ENHANCED: Process parallel operation results
   */
  private async processResults(
    results: PromiseSettledResult<any>[], 
    question: string,
    conversationEntry: ConversationEntry
  ): Promise<string> {
    const [photoResult, textOnlyResult] = results;
    
    // Try photo processing first if available
    if (photoResult.status === 'fulfilled' && photoResult.value) {
      this.logger.info(`📸 Photo captured, processing with vision...`);
      
      try {
        const photoData = photoResult.value;
        conversationEntry.hasPhoto = true;
        conversationEntry.photoData = {
          requestId: conversationEntry.id,
          mimeType: photoData.mimeType,
          buffer: photoData.buffer
        };
        return await this.safeVisionProcessing(question, photoData);
      } catch (error) {
        this.logger.warn(`🤖 Vision processing failed, falling back to text-only`);
      }
    }
    
    // Use text-only result as fallback
    if (textOnlyResult.status === 'fulfilled') {
      this.logger.info(`📝 Using text-only response`);
      return textOnlyResult.value;
    }
    
    // Final fallback
    return "I'm ready to help! Could you try asking your question again?";
  }

  /**
   * ENHANCED: Safe vision processing with retry
   */
  private async safeVisionProcessing(question: string, photo: PhotoData): Promise<string> {
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`🤖 Vision processing attempt ${attempt}/${maxRetries}`);
        
        const model = this.gemini.getGenerativeModel({ 
          model: "gemini-1.5-flash",
          generationConfig: {
            maxOutputTokens: 150,
            temperature: 0.7
          }
        });

        // Check image size first
        let imageData = photo.buffer.toString('base64');
        if (imageData.length > 1000000) {
          this.logger.info(`🖼️ Large image detected, using text-only response`);
          return await this.safeTextOnlyProcessing(question);
        }

        const prompt = `Smart glasses user asked: "${question}" about this image. 
Give a helpful 1-2 sentence response for text-to-speech.`;

        const result = await Promise.race([
          model.generateContent([
            prompt,
            { inlineData: { data: imageData, mimeType: photo.mimeType } }
          ]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Vision timeout attempt ${attempt}`)), 8000)
          )
        ]) as any;

        const response = await result.response;
        const text = response.text();
        
        if (text && text.trim().length > 0) {
          return text;
        }
        
        throw new Error('Empty response from Gemini Vision');
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`🤖 Vision processing attempt ${attempt} failed: ${errorMessage}`);
        
        if (attempt === maxRetries) {
          // Fallback to text-only processing
          return await this.safeTextOnlyProcessing(question);
        }
        
        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return await this.safeTextOnlyProcessing(question);
  }

  /**
   * ENHANCED: TTS with retry mechanism and async feedback
   */
  private async speakResponseWithRetry(session: AppSession, response: string): Promise<void> {
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`🗣️ TTS attempt ${attempt}/${maxRetries}: "${response}"`);
        
        // Try TTS with timeout
        const result = await Promise.race([
          session.audio.speak(response),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`TTS timeout attempt ${attempt}`)), 10000)
          )
        ]) as any;
        
        if (result.success) {
          this.logger.info(`✅ TTS successful on attempt ${attempt}`);
          // Show text as backup (non-blocking)
          this.showFeedbackAsync(session, `AI: ${response}`, 4000);
          return;
        } else {
          throw new Error(result.error || 'TTS failed');
        }
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`🗣️ TTS attempt ${attempt} failed: ${errorMessage}`);
        
        if (attempt === maxRetries) {
          this.logger.info(`🗣️ All TTS attempts failed, showing text only`);
          // Final fallback to text only
          this.showFeedbackAsync(session, `AI: ${response}`, 6000);
          return;
        }
        
        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  }

  /**
   * ENHANCED: Non-blocking feedback display
   */
  private showFeedbackAsync(session: AppSession, message: string, durationMs: number): void {
    setImmediate(() => {
      try {
        session.layouts.showTextWall(message, { durationMs });
      } catch (error) {
        this.logger.warn(`⚠️ Failed to show feedback: ${error}`);
      }
    });
  }

  /**
   * OPTIMIZED: Faster wake word detection
   */
  private detectWakeWord(text: string): boolean {
    const wakeWords = ['hey mentra', 'hi mentra', 'hey mantra'];
    return wakeWords.some(word => text.includes(word));
  }

  /**
   * OPTIMIZED: Simpler question extraction
   */
  private extractQuestion(text: string): string {
    const wakeWords = ['hey mentra', 'hi mentra', 'hey mantra'];
    
    for (const wakeWord of wakeWords) {
      const index = text.indexOf(wakeWord);
      if (index !== -1) {
        const question = text.substring(index + wakeWord.length).trim();
        return question.length > 2 ? question : "What do you see?";
      }
    }
    
    return "What do you see?";
  }

  /**
   * Reset listening state for a user
   */
  private resetListeningState(userId: string): void {
    const currentState = this.listeningStates.get(userId);
    if (currentState) {
      this.listeningStates.set(userId, {
        isListening: false,
        timestamp: 0,
        session: currentState.session
      });
    }
  }
}

// Start the server
const app = new HeyMentraVoiceAssistant();
app.start().catch(console.error); 