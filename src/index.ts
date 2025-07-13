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
  private sseClients: Map<string, any> = new Map(); // Store SSE response objects for real-time updates

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
            background: #0a0a0a;
            min-height: 100vh;
            color: #ffffff;
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
            background: #1a1a1a;
            padding: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #2a2a2a;
        }
        
        .device-status {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 0.9rem;
            color: #888;
        }
        
        .device-status.connected {
            color: #4CAF50;
        }
        
        .settings-btn {
            background: none;
            border: none;
            color: #888;
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
            background: #1a1a1a;
            border-top: 1px solid #2a2a2a;
            display: flex;
            justify-content: space-around;
            padding: 10px 0;
            z-index: 1000;
        }
        
        .nav-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 5px;
            padding: 10px;
            border: none;
            background: none;
            color: #666;
            font-size: 0.75rem;
            cursor: pointer;
            transition: color 0.3s;
        }
        
        .nav-item.active {
            color: #ffffff;
        }
        
        .nav-icon {
            font-size: 1.5rem;
        }
        
        /* Card styles for conversations */
        .card {
            background: #1a1a1a;
            border-radius: 16px;
            padding: 16px;
            margin-bottom: 12px;
            border: 1px solid #2a2a2a;
            transition: all 0.3s ease;
        }
        
        .card:hover {
            background: #222;
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
            background: #2a2a2a;
            border-radius: 20px;
            font-size: 0.85rem;
            color: #888;
        }
        
        .category-icon {
            font-size: 1rem;
        }
        
        .time-badge {
            font-size: 0.85rem;
            color: #666;
        }
        
        .card-title {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 8px;
            color: #fff;
        }
        
        .card-description {
            font-size: 0.95rem;
            color: #888;
            line-height: 1.5;
        }
        
        /* Recording status */
        .recording-status {
            background: #1a1a1a;
            border-radius: 16px;
            padding: 20px;
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border: 1px solid #2a2a2a;
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
            color: #888;
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
            background: #1a1a1a;
            border: 1px solid #2a2a2a;
            border-radius: 12px;
            padding: 12px 16px;
            color: white;
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
            color: white;
            font-size: 1rem;
        }
        
        .search-bar input::placeholder {
            color: #666;
        }
        
        .filter-btn {
            background: #1a1a1a;
            border: 1px solid #2a2a2a;
            border-radius: 12px;
            padding: 12px;
            color: #888;
            cursor: pointer;
            font-size: 1.2rem;
        }
        
        /* Date headers */
        .date-header {
            font-size: 1.2rem;
            font-weight: 600;
            margin: 20px 0 10px;
            color: #fff;
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
            background: #1a1a1a;
            border-radius: 12px;
            padding: 16px;
            text-align: center;
            border: 1px solid #2a2a2a;
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: bold;
            color: #fff;
        }
        
        .stat-label {
            font-size: 0.85rem;
            color: #666;
            margin-top: 4px;
        }
        
        .live-transcript {
            background: #1a1a1a;
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 20px;
            border: 1px solid #2a2a2a;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .transcript-text {
            flex: 1;
            color: #fff;
            font-size: 1rem;
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
            color: #666;
        }
        
        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid #2a2a2a;
            border-top: 4px solid #fff;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #666;
        }
        
        .empty-state h3 {
            color: #888;
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
                            <div style={{marginTop: '8px', fontSize: '0.9rem', color: '#888'}}>
                                Speaker 0: Hey Mentra
                            </div>
                        </div>
                        <div className="listening-indicator">
                            <span>Listening</span>
                            <div className="listening-dot"></div>
                        </div>
                    </div>

                    {liveTranscript && (
                        <div className="live-transcript">
                            <span className="pulse">🎤</span>
                            <span className="transcript-text">{liveTranscript}</span>
                        </div>
                    )}

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

                    <h3 className="date-header">Recent Activity</h3>
                    {conversations.slice(0, 3).map(conv => (
                        <div key={conv.id} className="card">
                            <div className="card-header">
                                <div className="category-badge">
                                    <span className="category-icon">{conv.category === 'Technology' ? '💻' : conv.category === 'Personal' ? '👤' : '🔍'}</span>
                                    {conv.category || 'General'}
                                </div>
                                <span className="time-badge">{formatTime(conv.timestamp)}</span>
                            </div>
                            <div className="card-title">{conv.question}</div>
                            <div className="card-description">{conv.response.substring(0, 100)}...</div>
                        </div>
                    ))}
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
          
          // Broadcast all transcriptions (both partial and final) for real-time display
          if (data.text && data.text.trim()) {
            this.broadcastSSE(userId, {
              type: 'transcription',
              text: data.text,
              isFinal: data.isFinal,
              timestamp: Date.now()
            });
          }
          
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
      
      // ENHANCED PARALLEL PROCESSING with better promise handling
      const parallelOperations = await this.executeParallelOperations(request, request.userId);
      
      // Process results with fallback chain
      const finalResponse = await this.processResults(parallelOperations, request.question, conversationEntry);
      
      // Update conversation entry with results
      conversationEntry.response = finalResponse;
      conversationEntry.processingTime = Date.now() - startTime;
      conversationEntry.status = 'completed';
      
      // Broadcast conversation completed event
      this.broadcastSSE(request.userId, {
        type: 'conversation-completed',
        conversation: conversationEntry
      });
      
      // ENHANCED TTS with retry mechanism
      await this.speakResponseWithRetry(request.session, finalResponse);
      
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
    const wakeWords = ['hey mentra', 'hi mentra', 'hey mantra'];
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