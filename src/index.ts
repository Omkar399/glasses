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
  location?: {
    lat: number;
    lng: number;
    address?: string;
  };
  category?: string; // e.g., 'Technology', 'Personal', 'Work'
  // STEP TRACKING INTEGRATION
  stepNumber?: number;
  projectId?: string;
  isStepEntry?: boolean;
}

/**
 * Interface for tracking individual steps in any task
 */
interface StepEntry {
  id: string;
  stepNumber: number;
  timestamp: number;
  userId: string;
  action: string;          // User's request
  response: string;        // AI's response  
  context: string;         // Previous steps context
  isCompleted: boolean;
  projectId: string;
  projectName: string;
  hasPhoto: boolean;
  photoData?: {
    requestId: string;
    mimeType: string;
    buffer: Buffer;
  };
  processingTime: number;
  status: 'processing' | 'completed' | 'error' | 'skipped';
}

/**
 * Interface for tracking multi-step projects/guides
 */
interface ProjectEntry {
  id: string;
  name: string;
  userId: string;
  description: string;
  taskType: 'tech' | 'repair' | 'household' | 'automotive' | 'coding' | 'creative' | 'general';
  startedAt: number;
  lastUpdated: number;
  steps: StepEntry[];
  isActive: boolean;
  tags: string[];
  totalSteps: number;
  completedSteps: number;
  estimatedDuration?: string;
  safetyLevel: 'low' | 'medium' | 'high';
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
  private sseClients: Map<string, any> = new Map(); // Store SSE response objects

  // STEP TRACKING DATA STORAGE
  private userSteps: Map<string, StepEntry[]> = new Map(); // Store steps by userId
  private userProjects: Map<string, ProjectEntry[]> = new Map(); // Store projects by userId
  private activeProjects: Map<string, string> = new Map(); // Track active project ID by userId
  private stepCounters: Map<string, number> = new Map(); // Track step numbers per project

  // TWO-STAGE INTERACTION STATE WITH SILENCE DETECTION
  private listeningStates: Map<string, { 
    isListening: boolean; 
    timestamp: number; 
    session: AppSession;
    lastVoiceActivity: number; // Track last time we heard voice
    silenceStartTime: number; // Track when silence started
    hasSpokenSinceWakeWord: boolean; // Track if user has spoken since wake word
  }> = new Map(); // Track listening state per user
  
  // SILENCE DETECTION CONFIGURATION
  private readonly SILENCE_TIMEOUT = 2500; // 2.5 seconds of silence after speech to stop listening
  private readonly MAX_LISTENING_TIMEOUT = 45000; // 45 seconds maximum listening time as safety fallback
  private readonly VOICE_ACTIVITY_THRESHOLD = 3; // Minimum characters to consider as voice activity

  // OPERATION CANCELLATION TRACKING
  private activeTTSOperations: Map<string, AbortController> = new Map(); // Track active TTS per user
  private activeAIOperations: Map<string, AbortController> = new Map(); // Track active AI processing per user

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
        status: conv.status,
        stepNumber: conv.stepNumber,
        projectId: conv.projectId,
        isStepEntry: conv.isStepEntry
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

    // API endpoint to get step tracking data
    app.get('/api/steps', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const userSteps = this.userSteps.get(userId) || [];
      const userProjects = this.userProjects.get(userId) || [];
      const activeProjectId = this.activeProjects.get(userId);

      // Sanitize step data for client
      const sanitizedSteps = userSteps.map(step => ({
        id: step.id,
        stepNumber: step.stepNumber,
        timestamp: step.timestamp,
        action: step.action,
        response: step.response,
        isCompleted: step.isCompleted,
        projectId: step.projectId,
        projectName: step.projectName,
        hasPhoto: step.hasPhoto,
        processingTime: step.processingTime,
        status: step.status
      }));

      // Sanitize project data for client
      const sanitizedProjects = userProjects.map(project => ({
        id: project.id,
        name: project.name,
        description: project.description,
        taskType: project.taskType,
        startedAt: project.startedAt,
        lastUpdated: project.lastUpdated,
        isActive: project.isActive,
        tags: project.tags,
        totalSteps: project.totalSteps,
        completedSteps: project.completedSteps,
        estimatedDuration: project.estimatedDuration,
        safetyLevel: project.safetyLevel
      }));

      res.json({
        steps: sanitizedSteps,
        projects: sanitizedProjects,
        activeProjectId,
        totalSteps: userSteps.length,
        completedSteps: userSteps.filter(s => s.isCompleted).length
      });
    });

    // API endpoint to get step photo data
    app.get('/api/step-photo/:stepId', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      const stepId = req.params.stepId;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const userSteps = this.userSteps.get(userId) || [];
      const step = userSteps.find(s => s.id === stepId);
      
      if (!step || !step.photoData) {
        res.status(404).json({ error: 'Step photo not found' });
        return;
      }

      res.set({
        'Content-Type': step.photoData.mimeType,
        'Cache-Control': 'no-cache'
      });
      res.send(step.photoData.buffer);
    });

    // Main webview route - serves React UI
    app.get('/webview', async (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      // if (!userId) {
      //   res.status(401).send(`
      //     <!DOCTYPE html>
      //     <html>
      //       <head>
      //         <title>Hey Mentra - Not Authenticated</title>
      //         <meta name="viewport" content="width=device-width, initial-scale=1.0">
      //       </head>
      //       <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: white;">
      //         <h1>🔒 Please open this page from the MentraOS app</h1>
      //       </body>
      //     </html>
      //   `);
      //   return;
      // }

      // Serve the React-based mobile UI
      const html = this.generateReactWebviewHTML();
      res.send(html);
    });

    // SSE endpoint for real-time updates
    app.get('/api/events', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId || 'anonymous';
      
      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      
      // Store client connection
      this.sseClients.set(userId, res);
      this.logger.info(`📡 SSE client connected for user ${userId}`);
      
      // Send initial connection event
      res.write(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`);
      
      // Handle client disconnect
      req.on('close', () => {
        this.sseClients.delete(userId);
        this.logger.info(`📡 SSE client disconnected for user ${userId}`);
      });
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
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f8f9fa;
            min-height: 100vh;
            color: #212529;
            overflow-x: hidden;
        }
        
        .container {
            max-width: 100%;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            padding-bottom: 80px; /* Space for bottom nav */
        }
        
        /* Header with device status */
        .header {
            background: #ffffff;
            padding: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #e9ecef;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }
        
        .device-status {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 0.9rem;
            color: #6c757d;
        }
        
        .device-status.connected {
            color: #28a745;
        }
        
        .settings-btn {
            background: none;
            border: none;
            color: #6c757d;
            font-size: 1.5rem;
            cursor: pointer;
        }
        
        /* Tab content area */
        .tab-content {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
        }
        
        /* Bottom navigation */
        .bottom-nav {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: #ffffff;
            border-top: 1px solid #e9ecef;
            display: flex;
            justify-content: space-around;
            padding: 10px 0;
            z-index: 1000;
            box-shadow: 0 -2px 4px rgba(0,0,0,0.05);
        }
        
        .nav-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 5px;
            padding: 10px;
            border: none;
            background: none;
            color: #6c757d;
            font-size: 0.75rem;
            cursor: pointer;
            transition: color 0.3s;
        }
        
        .nav-item.active {
            color: #007bff;
        }
        
        .nav-icon {
            font-size: 1.5rem;
        }
        
        /* Card styles for conversations */
        .card {
            background: #ffffff;
            border-radius: 16px;
            padding: 16px;
            margin-bottom: 12px;
            border: 1px solid #e9ecef;
            transition: all 0.3s ease;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }
        
        .card:hover {
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            transform: translateY(-1px);
        }
        
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        
        .category-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            background: #f8f9fa;
            border-radius: 20px;
            font-size: 0.85rem;
            color: #6c757d;
            border: 1px solid #e9ecef;
        }
        
        .category-icon {
            font-size: 1rem;
        }
        
        .time-badge {
            font-size: 0.85rem;
            color: #adb5bd;
        }
        
        .card-title {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 8px;
            color: #212529;
        }
        
        .card-description {
            font-size: 0.95rem;
            color: #6c757d;
            line-height: 1.5;
        }
        
        /* Recording status */
        .recording-status {
            background: #ffffff;
            border-radius: 16px;
            padding: 20px;
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border: 1px solid #e9ecef;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }
        
        .recording-btn {
            background: #dc3545;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 0.9rem;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .listening-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            color: #6c757d;
        }
        
        .transcript-area {
            margin-top: 8px;
            min-height: 20px;
        }
        
        .live-transcript-inline {
            display: flex;
            align-items: flex-start;
            font-size: 0.9rem;
            color: #212529;
            line-height: 1.4;
            word-wrap: break-word;
            max-width: 100%;
        }
        
        .live-transcript-inline span:last-child {
            flex: 1;
        }
        
        /* Speech History */
        .speech-history {
            max-height: 400px;
            overflow-y: auto;
        }
        
        .speech-item {
            background: #ffffff;
            border-radius: 12px;
            padding: 12px 16px;
            margin-bottom: 8px;
            border: 1px solid #e9ecef;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }
        
        .speech-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        
        .speech-number {
            font-size: 0.8rem;
            color: #007bff;
            font-weight: 600;
        }
        
        .speech-time {
            font-size: 0.75rem;
            color: #adb5bd;
        }
        
        .speech-text {
            font-size: 0.95rem;
            color: #212529;
            line-height: 1.4;
            font-style: italic;
        }
        
        .listening-dot {
            width: 8px;
            height: 8px;
            background: #dc3545;
            border-radius: 50%;
            animation: pulse 1.5s ease-in-out infinite;
        }
        
        /* Search bar */
        .search-container {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }
        
        .search-bar {
            flex: 1;
            background: #ffffff;
            border: 1px solid #dee2e6;
            border-radius: 12px;
            padding: 12px 16px;
            color: #212529;
            font-size: 1rem;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .search-bar input {
            flex: 1;
            background: none;
            border: none;
            outline: none;
            color: #212529;
            font-size: 1rem;
        }
        
        .search-bar input::placeholder {
            color: #adb5bd;
        }
        
        .filter-btn {
            background: #ffffff;
            border: 1px solid #dee2e6;
            border-radius: 12px;
            padding: 12px;
            color: #6c757d;
            cursor: pointer;
            font-size: 1.2rem;
        }
        
        /* Date headers */
        .date-header {
            font-size: 1.2rem;
            font-weight: 600;
            margin: 20px 0 10px;
            color: #212529;
        }
        
        /* Map container */
        #map {
            height: calc(100vh - 200px);
            width: 100%;
            border-radius: 16px;
            overflow: hidden;
        }
        
        /* Stats grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
            margin-bottom: 20px;
        }
        
        .stat-card {
            background: #ffffff;
            border-radius: 12px;
            padding: 16px;
            text-align: center;
            border: 1px solid #e9ecef;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: bold;
            color: #212529;
        }
        
        .stat-label {
            font-size: 0.85rem;
            color: #6c757d;
            margin-top: 4px;
        }
        
        
        .pulse {
            display: inline-block;
            animation: pulse 1s ease-in-out infinite;
        }
        
        @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.2); opacity: 0.8; }
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: #6c757d;
        }
        
        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid #e9ecef;
            border-top: 4px solid #007bff;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #6c757d;
        }
        
        .empty-state h3 {
            color: #495057;
            margin-bottom: 10px;
        }
        
        @media (max-width: 768px) {
            .stats-grid {
                grid-template-columns: 1fr;
            }
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
            const [connected, setConnected] = useState(false);
            const [liveTranscript, setLiveTranscript] = useState('');
            const [activeTab, setActiveTab] = useState('home');
            const [searchQuery, setSearchQuery] = useState('');

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
                
                const eventSource = new EventSource('/api/events');
                
                eventSource.onopen = () => {
                    setConnected(true);
                };
                
                eventSource.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    
                    if (data.type === 'transcription') {
                        setLiveTranscript(data.text);
                        if (data.isFinal) {
                            setTimeout(() => setLiveTranscript(''), 2000);
                        }
                    } else if (data.type === 'conversation-started' || 
                        data.type === 'conversation-completed' || 
                        data.type === 'conversation-error') {
                        setConversations(prev => {
                            const updated = [...prev];
                            const index = updated.findIndex(c => c.id === data.conversation.id);
                            if (index >= 0) {
                                updated[index] = data.conversation;
                            } else {
                                updated.unshift(data.conversation);
                            }
                            return updated;
                        });
                        
                        setStats(prev => ({
                            ...prev,
                            lastActivity: Date.now()
                        }));
                    }
                };
                
                eventSource.onerror = () => {
                    setConnected(false);
                };
                
                return () => {
                    eventSource.close();
                };
            }, []);

            const formatTime = (timestamp) => {
                return new Date(timestamp).toLocaleString();
            };

            const formatDuration = (ms) => {
                return \`\${(ms / 1000).toFixed(1)}s\`;
            };

            const groupConversationsByDate = (convs) => {
                const groups = {};
                convs.forEach(conv => {
                    const date = new Date(conv.timestamp).toDateString();
                    if (!groups[date]) groups[date] = [];
                    groups[date].push(conv);
                });
                return groups;
            };

            const filteredConversations = conversations.filter(conv => 
                conv.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
                conv.response.toLowerCase().includes(searchQuery.toLowerCase())
            );

            const renderHomeTab = () => (
                <div>
                    <div className="recording-status">
                        <div>
                            <button className="recording-btn">
                                <span>🔴</span> Stop Recording
                            </button>
                            <div className="transcript-area">
                                {liveTranscript ? (
                                    <div className="live-transcript-inline">
                                        <span className="pulse" style={{marginRight: '8px'}}>🎤</span>
                                        <span>{liveTranscript}</span>
                                    </div>
                                ) : (
                                    <div style={{fontSize: '0.9rem', color: '#6c757d'}}>
                                        Hey Mentra
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="listening-indicator">
                            <span>Listening</span>
                            <div className="listening-dot"></div>
                        </div>
                    </div>

                    <div className="stats-grid">
                        <div className="stat-card">
                            <div className="stat-value">{conversations.length}</div>
                            <div className="stat-label">Total Conversations</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-value">{stats.activeUsers}</div>
                            <div className="stat-label">Active Users</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-value">{conversations.filter(c => c.hasPhoto).length}</div>
                            <div className="stat-label">Photos Captured</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-value">{connected ? 'Live' : 'Offline'}</div>
                            <div className="stat-label">Status</div>
                        </div>
                    </div>

                    <h3 className="date-header">Speech History</h3>
                    <div className="speech-history">
                        {conversations.length === 0 ? (
                            <div className="empty-state">
                                <p>No speech recorded yet</p>
                            </div>
                        ) : (
                            conversations.map((conv, index) => (
                                <div key={conv.id} className="speech-item">
                                    <div className="speech-header">
                                        <span className="speech-number">#{conversations.length - index}</span>
                                        <span className="speech-time">{formatTime(conv.timestamp)}</span>
                                    </div>
                                    <div className="speech-text">"{conv.question}"</div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            );

            const renderChatTab = () => (
                <div>
                    <div className="search-container">
                        <div className="search-bar">
                            <span>🔍</span>
                            <input 
                                type="text" 
                                placeholder="Search conversations..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <button className="filter-btn">📊</button>
                    </div>

                    {searchQuery ? (
                        <div>
                            <h3 className="date-header">Search Results ({filteredConversations.length})</h3>
                            {filteredConversations.map(conv => (
                                <div key={conv.id} className="card">
                                    <div className="card-header">
                                        <div className="category-badge">
                                            <span className="category-icon">{conv.category === 'Technology' ? '💻' : conv.category === 'Personal' ? '👤' : '🔍'}</span>
                                            {conv.category || 'General'}
                                        </div>
                                        <span className="time-badge">{formatTime(conv.timestamp)}</span>
                                    </div>
                                    <div className="card-title">{conv.question}</div>
                                    <div className="card-description">{conv.response}</div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="empty-state">
                            <h3>🔍 Search your conversations</h3>
                            <p>Try asking: "Where did I leave my keys?"</p>
                            <p>Or search for topics like "work" or "food"</p>
                        </div>
                    )}
                </div>
            );

            const renderMemoriesTab = () => {
                const groupedConversations = groupConversationsByDate(conversations);
                return (
                    <div>
                        {Object.entries(groupedConversations).map(([date, convs]) => (
                            <div key={date}>
                                <h3 className="date-header">{date}</h3>
                                {convs.map(conv => (
                                    <div key={conv.id} className="card">
                                        <div className="card-header">
                                            <div className="category-badge">
                                                <span className="category-icon">{conv.category === 'Technology' ? '💻' : conv.category === 'Personal' ? '👤' : '🔍'}</span>
                                                {conv.category || 'General'}
                                            </div>
                                            <span className="time-badge">{formatTime(conv.timestamp)}</span>
                                        </div>
                                        <div className="card-title">{conv.question}</div>
                                        <div className="card-description">{conv.response}</div>
                                        {conv.hasPhoto && (
                                            <img 
                                                src={\`/api/photo/\${conv.id}\`}
                                                alt="Memory"
                                                style={{width: '100%', marginTop: '12px', borderRadius: '8px'}}
                                                onClick={() => window.open(\`/api/photo/\${conv.id}\`, '_blank')}
                                            />
                                        )}
                                    </div>
                                ))}
                            </div>
                        ))}
                        {conversations.length === 0 && (
                            <div className="empty-state">
                                <h3>📸 No memories yet</h3>
                                <p>Start conversations to build your memory timeline</p>
                            </div>
                        )}
                    </div>
                );
            };

            const renderMapsTab = () => {
                useEffect(() => {
                    if (activeTab === 'maps' && window.L) {
                        setTimeout(() => {
                            const mapElement = document.getElementById('map');
                            if (mapElement && !mapElement._leaflet_id) {
                                const map = L.map('map').setView([37.7749, -122.4194], 13);
                                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
                                
                                conversations.forEach(conv => {
                                    if (conv.location) {
                                        const marker = L.marker([conv.location.lat, conv.location.lng]).addTo(map);
                                        marker.bindPopup(\`
                                            <strong>\${conv.question}</strong><br>
                                            \${conv.response.substring(0, 100)}...<br>
                                            <small>\${formatTime(conv.timestamp)}</small>
                                        \`);
                                    }
                                });
                            }
                        }, 100);
                    }
                }, [activeTab]);

                return (
                    <div>
                        <h3 className="date-header">Conversation Locations</h3>
                        <div id="map"></div>
                    </div>
                );
            };

            if (loading) {
                return (
                    <div className="container">
                        <div className="loading">
                            <div className="spinner"></div>
                            <p>Loading...</p>
                        </div>
                    </div>
                );
            }

            return (
                <div className="container">
                    <div className="header">
                        <div className="device-status" className={connected ? 'connected' : ''}>
                            <span>⚙️</span>
                            <span>{connected ? 'Mentra Connected' : 'No device found'}</span>
                        </div>
                        <button className="settings-btn">⚙️</button>
                    </div>

                    <div className="tab-content">
                        {activeTab === 'home' && renderHomeTab()}
                        {activeTab === 'chat' && renderChatTab()}
                        {activeTab === 'memories' && renderMemoriesTab()}
                        {activeTab === 'maps' && renderMapsTab()}
                    </div>

                    <div className="bottom-nav">
                        <button 
                            className={\`nav-item \${activeTab === 'home' ? 'active' : ''}\`}
                            onClick={() => setActiveTab('home')}
                        >
                            <div className="nav-icon">🏠</div>
                            <div>Home</div>
                        </button>
                        <button 
                            className={\`nav-item \${activeTab === 'chat' ? 'active' : ''}\`}
                            onClick={() => setActiveTab('chat')}
                        >
                            <div className="nav-icon">💬</div>
                            <div>Chat</div>
                        </button>
                        <button 
                            className={\`nav-item \${activeTab === 'memories' ? 'active' : ''}\`}
                            onClick={() => setActiveTab('memories')}
                        >
                            <div className="nav-icon">🖼️</div>
                            <div>Memories</div>
                        </button>
                        <button 
                            className={\`nav-item \${activeTab === 'maps' ? 'active' : ''}\`}
                            onClick={() => setActiveTab('maps')}
                        >
                            <div className="nav-icon">🗺️</div>
                            <div>Maps</div>
                        </button>
                    </div>
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
      session: session,
      lastVoiceActivity: Date.now(),
      silenceStartTime: 0,
      hasSpokenSinceWakeWord: false
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
          
          // Broadcast all transcriptions (both partial and final) for real-time display
          if (data.text && data.text.trim()) {
            this.broadcastSSE(userId, {
              type: 'transcription',
              text: data.text,
              isFinal: data.isFinal,
              timestamp: Date.now()
            });
          }
          
          // Process both partial and final transcriptions for silence detection
          const spokenText = data.text.toLowerCase().trim();
          const listeningState = this.listeningStates.get(userId);
          
          // Handle wake word detection (only on final transcriptions)
          if (data.isFinal && !listeningState?.isListening) {
            this.logger.info(`🎤 Final transcription for user ${userId}: "${spokenText}"`);
            
            if (this.detectWakeWord(spokenText)) {
              this.logger.info(`🎯 Wake word detected for user ${userId}: "${spokenText}"`);
              
              // Start listening state with silence detection
              this.listeningStates.set(userId, {
                isListening: true,
                timestamp: Date.now(),
                session: session,
                lastVoiceActivity: Date.now(),
                silenceStartTime: 0,
                hasSpokenSinceWakeWord: false
              });
              
              // Speak confirmation (non-blocking)
              setImmediate(async () => {
                await this.speakWithRetry(session, "I'm listening, how can I help?", userId);
              });
              
              // Set maximum timeout as safety fallback
              setTimeout(() => {
                const currentState = this.listeningStates.get(userId);
                if (currentState?.isListening && currentState.timestamp === this.listeningStates.get(userId)?.timestamp) {
                  this.logger.info(`⏰ Maximum listening timeout reached for user ${userId}`);
                  this.resetListeningState(userId);
                  setImmediate(async () => {
                    await this.speakWithRetry(session, "Listening timeout. Say 'Hey Mentra' to try again.", userId);
                  });
                }
              }, this.MAX_LISTENING_TIMEOUT);
              
            } else {
              this.logger.debug(`🔇 No wake word detected in: "${spokenText}"`);
            }
            return;
          }

          // Handle listening state with silence detection
          if (listeningState?.isListening) {
            const now = Date.now();
            const timeSinceWakeWord = now - listeningState.timestamp;
            
            // Safety check for maximum timeout
            if (timeSinceWakeWord > this.MAX_LISTENING_TIMEOUT) {
              this.logger.info(`⏰ Maximum listening timeout for user ${userId}`);
              this.resetListeningState(userId);
              setImmediate(async () => {
                await this.speakWithRetry(session, "Listening timeout. Say 'Hey Mentra' to try again.", userId);
              });
              return;
            }
            
            // Check for voice activity (both partial and final transcriptions)
            if (spokenText && spokenText.length >= this.VOICE_ACTIVITY_THRESHOLD) {
              // Voice activity detected
              this.logger.debug(`🗣️ Voice activity detected for user ${userId}: "${spokenText}"`);
              
              // Update voice activity timestamp
              listeningState.lastVoiceActivity = now;
              listeningState.hasSpokenSinceWakeWord = true;
              listeningState.silenceStartTime = 0; // Reset silence timer
              
              // If this is a final transcription and user has spoken, process it
              if (data.isFinal && spokenText.length > 0) {
                this.logger.info(`🎤 Processing question from user ${userId}: "${spokenText}"`);
                
                // FIXED: In two-stage mode, use the spoken text directly as the question
                // Don't call extractQuestion() since wake word was already processed separately
                const question = spokenText;
                
                // Reset listening state before processing
                this.resetListeningState(userId);
                
                // Process the question (non-blocking)
                setImmediate(async () => {
                  await this.processRequest(question, session, userId);
                });
              }
            } else {
              // No significant voice activity in this transcription
              if (listeningState.hasSpokenSinceWakeWord && listeningState.silenceStartTime === 0) {
                // User has spoken before, start silence timer
                listeningState.silenceStartTime = now;
                this.logger.debug(`🤫 Silence started for user ${userId}`);
              }
              
              // Check if silence timeout has been reached
              if (listeningState.silenceStartTime > 0) {
                const silenceDuration = now - listeningState.silenceStartTime;
                
                if (silenceDuration >= this.SILENCE_TIMEOUT) {
                  this.logger.info(`🤫 Silence timeout (${silenceDuration}ms) reached for user ${userId}`);
                  this.resetListeningState(userId);
                  
                  // Only give feedback if user hasn't spoken at all
                  if (!listeningState.hasSpokenSinceWakeWord) {
                    setImmediate(async () => {
                      await this.speakWithRetry(session, "I didn't hear anything. Say 'Hey Mentra' to try again.", userId);
                    });
                  }
                }
              }
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
    // Add to queue for processing
    const request = { question, session, userId, timestamp: Date.now() };
    this.requestQueue.push(request);
    
    // Update last activity for webview (sessionId will be updated in onSession)
    this.activeUsers.set(userId, { 
      lastActivity: Date.now(), 
      sessionId: this.activeUsers.get(userId)?.sessionId || 'unknown'
    });
    
    this.logger.info(`📝 Request queued for user ${userId}. Queue length: ${this.requestQueue.length}`);
    
    // Process queue if not already processing
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
      status: 'processing',
      // Add mock location data (in real app, this would come from device GPS)
      location: {
        lat: 37.7749 + (Math.random() - 0.5) * 0.1, // San Francisco area
        lng: -122.4194 + (Math.random() - 0.5) * 0.1,
        address: 'San Francisco, CA'
      },
      category: this.categorizeQuestion(request.question)
    };
    
    // Add to user's conversation list
    const userConversations = this.conversations.get(request.userId) || [];
    userConversations.unshift(conversationEntry); // Add to beginning for latest-first display
    this.conversations.set(request.userId, userConversations);
    
    // Keep only last 50 conversations per user to prevent memory issues
    if (userConversations.length > 50) {
      userConversations.splice(50);
    }
    
    // Broadcast conversation started event
    this.broadcastSSE(request.userId, {
      type: 'conversation-started',
      conversation: conversationEntry
    });
    
    try {
      // Show immediate feedback (non-blocking)
      this.showFeedbackAsync(request.session, "Processing...", 1000);
      
      // ENHANCED SEQUENTIAL PROCESSING with cancellation
      const finalResponse = await this.executeSequentialOperations(request, request.userId, conversationEntry);
      
      // Update conversation entry with results
      conversationEntry.response = finalResponse;
      conversationEntry.processingTime = Date.now() - startTime;
      conversationEntry.status = 'completed';
      
      // STEP TRACKING: Create step entry if this is step-related
      const isStepRequest = this.detectStepRequest(request.question);
      const isStepContinuation = this.detectStepContinuation(request.question);
      
      if (isStepRequest || isStepContinuation) {
        try {
          const project = this.getOrCreateProject(request.userId, request.question);
          const stepEntry = this.createStepEntry(request.userId, request.question, finalResponse, project, conversationEntry);
          
          // Broadcast step events
          this.broadcastSSE(request.userId, {
            type: 'step-created',
            step: stepEntry,
            project: project
          });
          
          this.logger.info(`📋 Step tracking: Created step ${stepEntry.stepNumber} for project "${project.name}"`);
        } catch (error) {
          this.logger.error(`❌ Failed to create step entry:`, error);
        }
      }
      
      // Broadcast conversation completed event
      this.broadcastSSE(request.userId, {
        type: 'conversation-completed',
        conversation: conversationEntry
      });
      
      // ENHANCED TTS with cancellation
      await this.speakResponseWithCancellation(request.session, finalResponse, request.userId);
      
    } catch (error) {
      this.logger.error(`❌ Request failed:`, error);
      
      // Update conversation entry with error
      conversationEntry.response = "Sorry, I encountered an error. Please try again.";
      conversationEntry.processingTime = Date.now() - startTime;
      conversationEntry.status = 'error';
      
      // Broadcast conversation error event
      this.broadcastSSE(request.userId, {
        type: 'conversation-error',
        conversation: conversationEntry
      });
      
      // Async error response (non-blocking)
      setImmediate(async () => {
        await this.speakResponseWithCancellation(request.session, "Sorry, please try again.", request.userId);
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
   * ENHANCED: Execute operations sequentially with proper cancellation
   */
  private async executeSequentialOperations(request: { question: string; session: AppSession; userId: string; timestamp: number }, userId: string, conversationEntry: ConversationEntry): Promise<string> {
    // Cancel any existing AI operations for this user
    const existingController = this.activeAIOperations.get(userId);
    if (existingController) {
      existingController.abort();
    }

    // Create new abort controller for this operation
    const controller = new AbortController();
    this.activeAIOperations.set(userId, controller);

    try {
      // Check if request was cancelled
      if (controller.signal.aborted) {
        throw new Error('Operation cancelled');
      }

      // STEP TRACKING: Check if this is a step-based request
      const isStepRequest = this.detectStepRequest(request.question);
      const isStepContinuation = this.detectStepContinuation(request.question);
      const isStepRelated = isStepRequest || isStepContinuation;

      // Strategy 1: Try photo + vision processing first
      try {
        this.logger.info(`📸 Attempting photo capture for user ${userId}...`);
        const photo = await this.safePhotoCapture(request.session, userId);
        
        if (photo && !controller.signal.aborted) {
          this.logger.info(`📸 Photo captured, processing with vision...`);
          
          // ESSENTIAL: Store photo data in conversation entry
          conversationEntry.hasPhoto = true;
          conversationEntry.photoData = {
            requestId: conversationEntry.id,
            mimeType: photo.mimeType,
            buffer: photo.buffer
          };
          
          let visionResponse: string;
          if (isStepRelated) {
            visionResponse = await this.safeVisionProcessingWithSteps(request.question, photo, userId, controller.signal);
          } else {
            visionResponse = await this.safeVisionProcessing(request.question, photo, userId, controller.signal);
          }
          
          if (visionResponse && !controller.signal.aborted) {
            this.logger.info(`✅ Vision processing successful`);
            return visionResponse;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error('Operation cancelled');
        }
        this.logger.warn(`📸 Photo + vision strategy failed: ${error}`);
      }

      // Strategy 2: Fallback to text-only processing
      if (!controller.signal.aborted) {
        this.logger.info(`📝 Falling back to text-only processing...`);
        
        let textResponse: string;
        if (isStepRelated) {
          textResponse = await this.safeTextProcessingWithSteps(request.question, userId, true, controller.signal);
        } else {
          textResponse = await this.safeTextOnlyProcessing(request.question, userId, controller.signal);
        }
        
        if (textResponse && !controller.signal.aborted) {
          this.logger.info(`✅ Text processing successful`);
          return textResponse;
        }
      }

      // Final fallback
      return "I'm ready to help! Could you try asking your question again?";

    } finally {
      // Clean up controller
      this.activeAIOperations.delete(userId);
    }
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
      
      // Broadcast photo captured event
      this.broadcastSSE(userId, {
        type: 'photo-captured',
        timestamp: Date.now()
      });
      
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
   * ENHANCED: Safe text-only processing with conversation context and cancellation
   */
  private async safeTextOnlyProcessing(question: string, userId?: string, signal?: AbortSignal): Promise<string> {
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if cancelled
        if (signal?.aborted) {
          throw new Error('Operation cancelled');
        }

        this.logger.info(`🤖 Text processing attempt ${attempt}/${maxRetries}`);
        
        const model = this.gemini.getGenerativeModel({ 
          model: "gemini-2.5-flash-lite-preview-06-17",
          generationConfig: {
            maxOutputTokens: 500,
            temperature: 0.7
          }
        });

        let prompt: string;
        
        if (userId) {
          // Include conversation context for personalized response
          const conversationContext = this.buildConversationContext(userId, question);
          prompt = `You are a smart glasses AI assistant. User asked: "${question}".

${conversationContext}

Give a helpful 1-2 sentence response. Be conversational for text-to-speech. Use conversation history to provide relevant, personalized responses.`;
        } else {
          // Fallback for when userId is not available
          prompt = `Smart glasses AI assistant. User asked: "${question}". 
Give a helpful 1-sentence response. Be conversational for text-to-speech.`;
        }

        const result = await Promise.race([
          model.generateContent([prompt]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Gemini timeout attempt ${attempt}`)), 6000)
          ),
          // Add cancellation support
          signal ? new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Operation cancelled')));
          }) : new Promise(() => {}) // No-op promise if no signal
        ]) as any;
        
        const response = await result.response;
        const text = response.text();
        
        if (text && text.trim().length > 0) {
          return text;
        }
        
        throw new Error('Empty response from Gemini');
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        if (errorMessage === 'Operation cancelled') {
          throw error;
        }
        
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
    
    // STEP TRACKING: Check if this is a step-based request
    const userId = conversationEntry.userId;
    const isStepRequest = this.detectStepRequest(question);
    const isStepContinuation = this.detectStepContinuation(question);
    
    let finalResponse: string;
    
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
        
        // STEP TRACKING: Enhanced vision processing with step context
        if (isStepRequest || isStepContinuation) {
          finalResponse = await this.safeVisionProcessingWithSteps(question, photoData, userId);
        } else {
          finalResponse = await this.safeVisionProcessing(question, photoData, userId);
        }
      } catch (error) {
        this.logger.warn(`🤖 Vision processing failed, falling back to text-only`);
        finalResponse = await this.safeTextProcessingWithSteps(question, userId, isStepRequest || isStepContinuation);
      }
    } else {
      // Use text-only result as fallback
      if (textOnlyResult.status === 'fulfilled') {
        this.logger.info(`📝 Using text-only response`);
        
        // STEP TRACKING: Enhanced text processing with step context
        if (isStepRequest || isStepContinuation) {
          finalResponse = await this.safeTextProcessingWithSteps(question, userId, true);
        } else {
          finalResponse = textOnlyResult.value;
        }
      } else {
        // Final fallback
        finalResponse = "I'm ready to help! Could you try asking your question again?";
      }
    }
    
    // STEP TRACKING: Create step entry if this is step-related
    if (isStepRequest || isStepContinuation) {
      try {
        const project = this.getOrCreateProject(userId, question);
        const stepEntry = this.createStepEntry(userId, question, finalResponse, project, conversationEntry);
        
        // Broadcast step events
        this.broadcastSSE(userId, {
          type: 'step-created',
          step: stepEntry,
          project: project
        });
        
        this.logger.info(`📋 Step tracking: Created step ${stepEntry.stepNumber} for project "${project.name}"`);
      } catch (error) {
        this.logger.error(`❌ Failed to create step entry:`, error);
      }
    }
    
    return finalResponse;
  }

  /**
   * STEP TRACKING: Enhanced text processing with step context and cancellation
   */
  private async safeTextProcessingWithSteps(question: string, userId: string, isStepRelated: boolean, signal?: AbortSignal): Promise<string> {
    if (!isStepRelated) {
      return await this.safeTextOnlyProcessing(question, userId, signal);
    }
    
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if cancelled
        if (signal?.aborted) {
          throw new Error('Operation cancelled');
        }

        this.logger.info(`🤖 Step-aware text processing attempt ${attempt}/${maxRetries}`);
        
        const model = this.gemini.getGenerativeModel({ 
          model: "gemini-2.5-flash-lite-preview-06-17",
          generationConfig: {
            maxOutputTokens: 300,  // Reduced to force shorter responses
            temperature: 0.7
          }
        });

        // Build comprehensive context (conversation + steps)
        const combinedContext = this.buildCombinedContext(userId, question, true);
        const activeProject = this.getActiveProject(userId);
        
        let prompt: string;
        if (this.detectStepRequest(question)) {
          // New step-based task
          prompt = `You are a smart glasses AI assistant helping with step-by-step tasks.

User asked: "${question}"

${combinedContext}

CRITICAL INSTRUCTIONS:
- Give ONLY the very first step to start this task
- Do NOT list multiple steps or the entire process
- Keep it to 1-2 sentences maximum
- End by asking the user to complete this step and then ask "what's next?"
- Be conversational and encouraging
- Use conversation history to personalize your response

Example format: "First, [action]. Once you've done that, say 'what's next?' and I'll guide you through the next step."

Current project: ${activeProject?.name || 'New task'}
Safety level: ${activeProject?.safetyLevel || 'low'}

Give ONLY the first step now:`;

        } else {
          // Continuation of existing steps
          prompt = `You are a smart glasses AI assistant continuing step-by-step guidance.

User said: "${question}" (they completed the previous step and want the next one)

${combinedContext}

CRITICAL INSTRUCTIONS:
- Give ONLY the very next single step
- Do NOT list multiple future steps
- Keep it to 1-2 sentences maximum
- End by asking them to complete this step and say "what's next?" when done
- Be conversational and encouraging
- Reference previous conversation if relevant

Example format: "Great! Now [next action]. Let me know when you've completed this step."

Give ONLY the next step now:`;
        }

        const result = await Promise.race([
          model.generateContent([prompt]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Step-aware processing timeout attempt ${attempt}`)), 8000)
          ),
          // Add cancellation support
          signal ? new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Operation cancelled')));
          }) : new Promise(() => {}) // No-op promise if no signal
        ]) as any;
        
        const response = await result.response;
        const text = response.text();
        
        if (text && text.trim().length > 0) {
          return text;
        }
        
        throw new Error('Empty response from Gemini');
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        if (errorMessage === 'Operation cancelled') {
          throw error;
        }
        
        this.logger.warn(`🤖 Step-aware processing attempt ${attempt} failed: ${errorMessage}`);
        
        if (attempt === maxRetries) {
          return "I'm ready to help with your next step! What would you like to work on?";
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return "I'm here to help! Could you repeat your question?";
  }

  /**
   * STEP TRACKING: Enhanced vision processing with step context and cancellation
   */
  private async safeVisionProcessingWithSteps(question: string, photo: PhotoData, userId: string, signal?: AbortSignal): Promise<string> {
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if cancelled
        if (signal?.aborted) {
          throw new Error('Operation cancelled');
        }

        this.logger.info(`🤖 Step-aware vision processing attempt ${attempt}/${maxRetries}`);
        
        const model = this.gemini.getGenerativeModel({ 
          model: "gemini-2.5-flash-lite-preview-06-17",
          generationConfig: {
            maxOutputTokens: 300,  // Reduced to force shorter responses
            temperature: 0.7
          }
        });

        // Check image size first
        let imageData = photo.buffer.toString('base64');
        if (imageData.length > 1000000) {
          this.logger.info(`🖼️ Large image detected, using text-only response`);
          return await this.safeTextProcessingWithSteps(question, userId, true, signal);
        }

        // Build comprehensive context (conversation + steps)
        const combinedContext = this.buildCombinedContext(userId, question, true);

        const prompt = `You are a smart glasses AI assistant with vision capabilities helping with step-by-step tasks.

User asked: "${question}" about this image.

${combinedContext}

CRITICAL INSTRUCTIONS:
- Look at the image and assess the current situation
- Give ONLY the very next single step based on what you see
- Do NOT list multiple future steps or entire process
- Keep it to 1-2 sentences maximum
- If you see the previous step is complete, give the next step
- If you see issues or safety concerns, address them first
- End by asking them to complete this step and say "what's next?" when done
- Be conversational and encouraging
- Use conversation history to provide personalized guidance

Example format: "I can see [observation]. Now [next action]. Let me know when you've completed this step."

Give ONLY the next step based on what you see:`;

        const result = await Promise.race([
          model.generateContent([
            prompt,
            { inlineData: { data: imageData, mimeType: photo.mimeType } }
          ]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Step-aware vision timeout attempt ${attempt}`)), 10000)
          ),
          // Add cancellation support
          signal ? new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Operation cancelled')));
          }) : new Promise(() => {}) // No-op promise if no signal
        ]) as any;

        const response = await result.response;
        const text = response.text();
        
        if (text && text.trim().length > 0) {
          return text;
        }
        
        throw new Error('Empty response from Gemini Vision');
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        if (errorMessage === 'Operation cancelled') {
          throw error;
        }
        
        this.logger.warn(`🤖 Step-aware vision processing attempt ${attempt} failed: ${errorMessage}`);
        
        if (attempt === maxRetries) {
          return await this.safeTextProcessingWithSteps(question, userId, true, signal);
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return await this.safeTextProcessingWithSteps(question, userId, true, signal);
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
   * Send SSE event to connected clients
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

  /**
   * OPTIMIZED: Faster wake word detection
   */
  private detectWakeWord(text: string): boolean {
    const wakeWords = [
      // Core Variants
      'hey mentra', 'heyy mentra', 'hey mentraaa', 'hey mentra buddy', 'hey there mentra',
      'hey mentra please', 'hey mentra now',
    
      // Phonetic Variants / Common Mishearings
      'he mentra', 'hementra', 'hamentra', 'hem entra', 'hai mentra', 'hay mentra',
      'heymantra', 'hey mantra', 'hey mantraa', 'aye mentra', 'hi mentra',
      'hemantra', 'huh mentra', 'hae mentra', 'hae mantra', 'hee mentra',
    
      // Likely ASR Misinterpretations
      'hey mentor', 'hey mantra', 'hey manta', 'hey mental', 'a man try', 'hey mancha',
      'hey mendra', 'a mentor', 'hey matra', 'hey mentee', 'hey mantraa',
      'hey mendra', 'aye mantra',
    
      // Aggressive Slurring or Accentual Variants
      "h'mentra", 'aymentra', 'aymenta', 'hemtra', 'hementa', 'ammentra',
      'yamentra', 'h\'mentra', 'aymentrah', 'haimen'
    ];
    return wakeWords.some(word => text.includes(word));
  }

  /**
   * Categorize question based on keywords
   */
  private categorizeQuestion(question: string): string {
    const q = question.toLowerCase();
    if (q.includes('code') || q.includes('programming') || q.includes('function') || q.includes('debug')) {
      return 'Technology';
    } else if (q.includes('keys') || q.includes('wallet') || q.includes('phone') || q.includes('where')) {
      return 'Personal';
    } else if (q.includes('meeting') || q.includes('work') || q.includes('email') || q.includes('deadline')) {
      return 'Work';
    } else if (q.includes('food') || q.includes('recipe') || q.includes('cook') || q.includes('eat')) {
      return 'Food';
    }
    return 'General';
  }

  /**
   * STEP TRACKING: Detect if user is asking for step-by-step help
   */
  private detectStepRequest(question: string): boolean {
    const stepKeywords = [
      'help me build', 'help me create', 'help me make', 'help me setup', 'help me configure',
      'help me install', 'help me fix', 'help me repair', 'help me change', 'help me replace',
      'how to build', 'how to create', 'how to make', 'how to setup', 'how to configure',
      'how to install', 'how to fix', 'how to repair', 'how to change', 'how to replace',
      'how do i', 'how can i', 'walk me through', 'guide me through', 'show me how',
      'step by step', 'tutorial', 'instructions', 'guide me', 'help me with',
      'put my phone in', 'change my tv', 'connect my', 'set up my'
    ];
    
    const q = question.toLowerCase();
    const isStepRequest = stepKeywords.some(keyword => q.includes(keyword));
    
    // Log detection for debugging
    if (isStepRequest) {
      this.logger.info(`📋 Step request detected: "${question}"`);
    }
    
    return isStepRequest;
  }

  /**
   * STEP TRACKING: Detect if user is continuing a step sequence
   */
  private detectStepContinuation(question: string): boolean {
    const continuationKeywords = [
      'what\'s next', 'whats next', 'next step', 'what now', 'now what',
      'continue', 'keep going', 'what\'s the next step', 'what should i do next',
      'done', 'finished', 'completed', 'ready for next', 'next', 'ok', 'okay',
      'got it', 'did it', 'finished that', 'completed that', 'ready'
    ];
    
    const q = question.toLowerCase().trim();
    
    // Strong indicators of continuation
    const isExplicitContinuation = continuationKeywords.some(keyword => q.includes(keyword));
    
    // Short responses often mean "continue" but only if there's an active project
    const isShortResponse = q.length < 15;
    
    // Log detection for debugging
    if (isExplicitContinuation || isShortResponse) {
      this.logger.info(`📋 Step continuation detected: "${question}" (explicit: ${isExplicitContinuation}, short: ${isShortResponse})`);
    }
    
    return isExplicitContinuation || isShortResponse;
  }

  /**
   * STEP TRACKING: Extract project name and type from task description
   */
  private extractProjectInfo(taskDescription: string): { name: string; type: ProjectEntry['taskType']; safetyLevel: ProjectEntry['safetyLevel'] } {
    const q = taskDescription.toLowerCase();
    
    // Determine project type and safety level
    let type: ProjectEntry['taskType'] = 'general';
    let safetyLevel: ProjectEntry['safetyLevel'] = 'low';
    
    if (q.includes('website') || q.includes('app') || q.includes('code') || q.includes('program')) {
      type = 'coding';
    } else if (q.includes('phone') || q.includes('computer') || q.includes('router') || q.includes('device')) {
      type = 'tech';
    } else if (q.includes('car') || q.includes('engine') || q.includes('brake') || q.includes('oil')) {
      type = 'automotive';
      safetyLevel = 'high';
    } else if (q.includes('electrical') || q.includes('fuse') || q.includes('outlet') || q.includes('wiring')) {
      type = 'repair';
      safetyLevel = 'high';
    } else if (q.includes('tv') || q.includes('home') || q.includes('kitchen') || q.includes('bathroom')) {
      type = 'household';
    } else if (q.includes('art') || q.includes('design') || q.includes('music') || q.includes('video')) {
      type = 'creative';
    }
    
    // Generate project name
    let name = taskDescription;
    if (q.includes('build')) name = taskDescription.replace(/help me build|how to build/i, '').trim();
    if (q.includes('create')) name = taskDescription.replace(/help me create|how to create/i, '').trim();
    if (q.includes('make')) name = taskDescription.replace(/help me make|how to make/i, '').trim();
    if (q.includes('setup')) name = taskDescription.replace(/help me setup|how to setup/i, '').trim();
    if (q.includes('fix')) name = taskDescription.replace(/help me fix|how to fix/i, '').trim();
    
    // Clean up and capitalize
    name = name.replace(/^(a |an |the )/i, '').trim();
    name = name.charAt(0).toUpperCase() + name.slice(1);
    if (name.length < 3) name = taskDescription; // Fallback
    
    return { name, type, safetyLevel };
  }

  /**
   * STEP TRACKING: Build context from previous steps for AI prompt
   */
  private buildStepContext(userId: string, projectId?: string): string {
    const userSteps = this.userSteps.get(userId) || [];
    
    let relevantSteps: StepEntry[];
    if (projectId) {
      // Get steps from specific project
      relevantSteps = userSteps.filter(step => step.projectId === projectId);
    } else {
      // Get recent steps from active project
      const activeProjectId = this.activeProjects.get(userId);
      if (activeProjectId) {
        relevantSteps = userSteps.filter(step => step.projectId === activeProjectId);
      } else {
        relevantSteps = userSteps.slice(-3); // Last 3 steps if no active project
      }
    }
    
    if (relevantSteps.length === 0) {
      return "This is the first step of the project.";
    }
    
    const recentSteps = relevantSteps
      .slice(-3) // Last 3 steps for context
      .map(step => `Step ${step.stepNumber}: ${step.action} → ${step.response}`)
      .join('\n');
      
    return `Previous steps in this project:\n${recentSteps}\n\nContinue with next logical step.`;
  }

  /**
   * CONVERSATION CONTEXT: Build comprehensive conversation history for AI context
   */
  private buildConversationContext(userId: string, excludeCurrentQuestion?: string): string {
    const userConversations = this.conversations.get(userId) || [];
    
    if (userConversations.length === 0) {
      return "This is the start of our conversation.";
    }
    
    // Get last 5 conversations for context (excluding current if specified)
    let relevantConversations = userConversations
      .filter(conv => conv.status === 'completed')
      .slice(0, 5); // Most recent 5
    
    if (excludeCurrentQuestion) {
      relevantConversations = relevantConversations
        .filter(conv => conv.question !== excludeCurrentQuestion);
    }
    
    if (relevantConversations.length === 0) {
      return "This is the start of our conversation.";
    }
    
    const conversationHistory = relevantConversations
      .reverse() // Oldest first for chronological order
      .map(conv => {
        const timeAgo = this.getTimeAgo(conv.timestamp);
        return `[${timeAgo}] User: "${conv.question}" → AI: "${conv.response}"`;
      })
      .join('\n');
      
    return `Recent conversation history:\n${conversationHistory}\n\nUse this context to provide relevant, personalized responses.`;
  }

  /**
   * CONVERSATION CONTEXT: Build combined context (conversation + steps)
   */
  private buildCombinedContext(userId: string, currentQuestion: string, isStepRelated: boolean): string {
    const conversationContext = this.buildConversationContext(userId, currentQuestion);
    
    if (!isStepRelated) {
      return conversationContext;
    }
    
    const stepContext = this.buildStepContext(userId);
    const activeProject = this.getActiveProject(userId);
    
    let combined = conversationContext + '\n\n';
    
    if (activeProject) {
      combined += `CURRENT PROJECT: "${activeProject.name}" (${activeProject.taskType})\n`;
      combined += `Safety level: ${activeProject.safetyLevel}\n`;
      combined += `Progress: ${activeProject.completedSteps}/${activeProject.totalSteps} steps completed\n\n`;
    }
    
    combined += stepContext;
    
    return combined;
  }

  /**
   * UTILITY: Get human-readable time ago string
   */
  private getTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return 'over a week ago';
  }

  /**
   * STEP TRACKING: Create or get existing project
   */
  private getOrCreateProject(userId: string, taskDescription: string): ProjectEntry {
    const userProjects = this.userProjects.get(userId) || [];
    const activeProjectId = this.activeProjects.get(userId);
    
    // Check if we should continue existing active project
    if (activeProjectId) {
      const activeProject = userProjects.find(p => p.id === activeProjectId);
      if (activeProject && activeProject.isActive) {
        // Update last activity
        activeProject.lastUpdated = Date.now();
        return activeProject;
      }
    }
    
    // Create new project
    const projectInfo = this.extractProjectInfo(taskDescription);
    const projectId = `proj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const newProject: ProjectEntry = {
      id: projectId,
      name: projectInfo.name,
      userId: userId,
      description: taskDescription,
      taskType: projectInfo.type,
      startedAt: Date.now(),
      lastUpdated: Date.now(),
      steps: [],
      isActive: true,
      tags: [projectInfo.type],
      totalSteps: 0,
      completedSteps: 0,
      safetyLevel: projectInfo.safetyLevel
    };
    
    // Deactivate other projects for this user
    userProjects.forEach(p => p.isActive = false);
    
    // Add new project
    userProjects.push(newProject);
    this.userProjects.set(userId, userProjects);
    this.activeProjects.set(userId, projectId);
    this.stepCounters.set(projectId, 0);
    
    this.logger.info(`📋 Created new project for user ${userId}: "${newProject.name}" (${newProject.taskType})`);
    
    return newProject;
  }

  /**
   * STEP TRACKING: Create and store a step entry
   */
  private createStepEntry(
    userId: string, 
    action: string, 
    response: string, 
    project: ProjectEntry,
    conversationEntry: ConversationEntry
  ): StepEntry {
    const projectId = project.id;
    const currentStepCount = this.stepCounters.get(projectId) || 0;
    const stepNumber = currentStepCount + 1;
    
    const stepEntry: StepEntry = {
      id: `step_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      stepNumber: stepNumber,
      timestamp: Date.now(),
      userId: userId,
      action: action,
      response: response,
      context: this.buildStepContext(userId, projectId),
      isCompleted: false, // Will be marked completed when user continues
      projectId: projectId,
      projectName: project.name,
      hasPhoto: conversationEntry.hasPhoto,
      photoData: conversationEntry.photoData,
      processingTime: conversationEntry.processingTime,
      status: conversationEntry.status as any
    };
    
    // Update step counter
    this.stepCounters.set(projectId, stepNumber);
    
    // Add to user steps
    const userSteps = this.userSteps.get(userId) || [];
    userSteps.push(stepEntry);
    this.userSteps.set(userId, userSteps);
    
    // Add to project steps
    project.steps.push(stepEntry);
    project.totalSteps = stepNumber;
    project.lastUpdated = Date.now();
    
    // Mark previous step as completed if this is a continuation
    if (stepNumber > 1) {
      const previousStep = userSteps.find(s => s.projectId === projectId && s.stepNumber === stepNumber - 1);
      if (previousStep) {
        previousStep.isCompleted = true;
        project.completedSteps = stepNumber - 1;
      }
    }
    
    // Link conversation to step
    conversationEntry.stepNumber = stepNumber;
    conversationEntry.projectId = projectId;
    conversationEntry.isStepEntry = true;
    
    this.logger.info(`📝 Created step ${stepNumber} for project "${project.name}" (user: ${userId})`);
    
    return stepEntry;
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
        session: currentState.session,
        lastVoiceActivity: Date.now(),
        silenceStartTime: 0,
        hasSpokenSinceWakeWord: false
      });
    }
  }

  /**
   * STEP TRACKING: Get active project for user
   */
  private getActiveProject(userId: string): ProjectEntry | null {
    const activeProjectId = this.activeProjects.get(userId);
    if (!activeProjectId) return null;
    
    const userProjects = this.userProjects.get(userId) || [];
    return userProjects.find(p => p.id === activeProjectId) || null;
  }

  /**
   * ENHANCED: Safe vision processing with conversation context and cancellation
   */
  private async safeVisionProcessing(question: string, photo: PhotoData, userId?: string, signal?: AbortSignal): Promise<string> {
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if cancelled
        if (signal?.aborted) {
          throw new Error('Operation cancelled');
        }

        this.logger.info(`🤖 Vision processing attempt ${attempt}/${maxRetries}`);
        
        const model = this.gemini.getGenerativeModel({ 
          model: "gemini-2.5-flash-lite-preview-06-17",
          generationConfig: {
            maxOutputTokens: 150,
            temperature: 0.7
          }
        });

        // Check image size first
        let imageData = photo.buffer.toString('base64');
        if (imageData.length > 1000000) {
          this.logger.info(`🖼️ Large image detected, using text-only response`);
          return await this.safeTextOnlyProcessing(question, userId, signal);
        }

        let prompt: string;
        
        if (userId) {
          // Include conversation context for personalized response
          const conversationContext = this.buildConversationContext(userId, question);
          prompt = `You are a smart glasses AI assistant. User asked: "${question}" about this image.

${conversationContext}

Give a helpful 1-2 sentence response for text-to-speech. Use conversation history to provide relevant, personalized responses.`;
        } else {
          // Fallback for when userId is not available
          prompt = `Smart glasses user asked: "${question}" about this image. 
Give a helpful 1-2 sentence response for text-to-speech.`;
        }

        const result = await Promise.race([
          model.generateContent([
            prompt,
            { inlineData: { data: imageData, mimeType: photo.mimeType } }
          ]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Vision timeout attempt ${attempt}`)), 8000)
          ),
          // Add cancellation support
          signal ? new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Operation cancelled')));
          }) : new Promise(() => {}) // No-op promise if no signal
        ]) as any;

        const response = await result.response;
        const text = response.text();
        
        if (text && text.trim().length > 0) {
          return text;
        }
        
        throw new Error('Empty response from Gemini Vision');
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        if (errorMessage === 'Operation cancelled') {
          throw error;
        }
        
        this.logger.warn(`🤖 Vision processing attempt ${attempt} failed: ${errorMessage}`);
        
        if (attempt === maxRetries) {
          return await this.safeTextOnlyProcessing(question, userId, signal);
        }
        
        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return await this.safeTextOnlyProcessing(question, userId, signal);
  }

  /**
   * ENHANCED: TTS with proper cancellation to prevent overlapping speech
   */
  private async speakResponseWithCancellation(session: AppSession, response: string, userId: string): Promise<void> {
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

          this.logger.info(`🗣️ TTS attempt ${attempt}/${maxRetries} for user ${userId}: "${response}"`);
          
          // Try TTS with timeout and cancellation
          const result = await Promise.race([
            session.audio.speak(response),
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
          
          if (result.success) {
            this.logger.info(`✅ TTS successful for user ${userId} on attempt ${attempt}`);
            // Show text as backup (non-blocking)
            this.showFeedbackAsync(session, `AI: ${response}`, 4000);
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
            this.showFeedbackAsync(session, `AI: ${response}`, 6000);
            return;
          }
          
          // Brief delay before retry, but check for cancellation
          await new Promise(resolve => {
            const timeout = setTimeout(resolve, 300);
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
}

// Start the server
const app = new HeyMentraVoiceAssistant();
app.start().catch(console.error); 