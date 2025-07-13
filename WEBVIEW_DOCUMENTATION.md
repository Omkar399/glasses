# Hey Mentra Voice Assistant - Webview Documentation

## 🚀 Overview

The Hey Mentra Voice Assistant now includes a **mobile-optimized React webview** that displays real-time conversation data from the Mentra smart glasses. The entire webview system is implemented directly in `src/index.ts` as a single-file solution.

## 📱 Webview Access

- **URL**: `https://fitting-foal-blindly.ngrok-free.app/webview` (or `localhost:3000/webview`)
- **Authentication**: Requires MentraOS authentication
- **Mobile Optimized**: Responsive design for mobile devices
- **Auto-refresh**: Updates every 3 seconds

## 🏗️ Architecture

### Data Storage
```typescript
interface ConversationEntry {
  id: string;                    // Unique conversation ID
  timestamp: number;             // When conversation started
  userId: string;                // MentraOS user ID
  question: string;              // User's spoken question
  response: string;              // AI's response
  hasPhoto: boolean;             // Whether photo was captured
  photoData?: {                  // Photo data if available
    requestId: string;
    mimeType: string;
    buffer: Buffer;
  };
  processingTime: number;        // Processing duration in ms
  status: 'processing' | 'completed' | 'error';
}
```

### Storage Maps
- `conversations: Map<string, ConversationEntry[]>` - Stores conversations by userId
- `activeUsers: Map<string, { lastActivity: number; sessionId: string }>` - Tracks active users

## 🔌 API Endpoints

### GET `/webview`
- **Purpose**: Serves the React-based mobile UI
- **Authentication**: Required (MentraOS)
- **Response**: HTML page with embedded React app

### GET `/api/conversations`
- **Purpose**: Get conversation history for authenticated user
- **Authentication**: Required
- **Response**:
```json
{
  "conversations": [
    {
      "id": "conv_1234567890_abc123",
      "timestamp": 1640995200000,
      "question": "what do you see",
      "response": "I can see a beautiful sunset over the mountains.",
      "hasPhoto": true,
      "processingTime": 2500,
      "status": "completed"
    }
  ],
  "activeUsers": 3,
  "lastActivity": 1640995200000
}
```

### GET `/api/photo/:conversationId`
- **Purpose**: Get photo data for a specific conversation
- **Authentication**: Required
- **Response**: Binary image data with appropriate Content-Type

## 🎨 UI Features

### Dashboard Components
- **Header**: Logo and title
- **Status Cards**: 
  - Total conversations count
  - Active users count
  - Last activity time
- **Conversation List**: Real-time conversation display
- **Refresh Button**: Manual refresh capability

### Conversation Display
- **Question**: User's spoken question with 🎤 icon
- **Response**: AI's response with 🤖 icon
- **Photo**: Clickable image (if captured) that opens in new tab
- **Timestamp**: When conversation occurred
- **Status Badge**: Processing/completed/error status
- **Processing Time**: How long the AI took to respond

### Mobile Optimizations
- Responsive design for all screen sizes
- Touch-friendly interface
- Gradient background with glassmorphism effects
- Smooth animations and transitions
- Fixed refresh button for easy access

## 🔧 How to Extend

### Adding New Data Fields

1. **Update Interface**:
```typescript
interface ConversationEntry {
  // ... existing fields ...
  newField: string;              // Add your new field
}
```

2. **Update Storage**:
```typescript
// In processQueueAsync method
conversationEntry.newField = "your_value";
```

3. **Update API Response**:
```typescript
// In /api/conversations endpoint
const sanitizedConversations = userConversations.map(conv => ({
  // ... existing fields ...
  newField: conv.newField
}));
```

4. **Update UI**:
```jsx
// In the React component
<div className="new-field">
  📊 {conv.newField}
</div>
```

### Adding New API Endpoints

```typescript
// In setupWebviewRoutes method
app.get('/api/your-endpoint', (req: any, res: any) => {
  const userId = (req as AuthenticatedRequest).authUserId;
  
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  
  // Your logic here
  res.json({ data: "your_data" });
});
```

### Customizing UI Styles

All CSS is embedded in the `generateReactWebviewHTML()` method. Key classes:
- `.container` - Main container
- `.conversation-item` - Individual conversation cards
- `.status-card` - Dashboard status cards
- `.photo` - Photo display

### Adding Real-time Features

The UI auto-refreshes every 3 seconds. To add real-time updates:

1. **WebSocket Support** (if needed):
```typescript
// Add to constructor
private setupWebSocket() {
  // WebSocket implementation
}
```

2. **Server-Sent Events** (alternative):
```typescript
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  // SSE implementation
});
```

## 🛠️ Development Workflow

### Testing the Webview
1. Start the voice assistant: `npm start`
2. Open browser to: `http://localhost:3000/webview`
3. Authenticate through MentraOS
4. Test voice interactions with glasses
5. Watch real-time updates in webview

### Debugging
- Check browser console for React errors
- Check server logs for API issues
- Use network tab to monitor API calls
- Test mobile responsiveness with browser dev tools

### Performance Considerations
- Conversations are limited to 50 per user
- Photos are stored in memory (consider database for production)
- Auto-refresh interval can be adjusted (currently 3 seconds)
- Large images are automatically handled with fallback

## 🔒 Security Notes

- All endpoints require MentraOS authentication
- Photo data is only accessible to the owning user
- Conversation data is isolated by userId
- No sensitive data is logged in browser console

## 🚀 Future Enhancements

### Potential Features
1. **Export Conversations**: Download conversation history
2. **Search/Filter**: Search through conversations
3. **Analytics**: Usage statistics and insights
4. **Themes**: Dark/light mode toggle
5. **Notifications**: Browser notifications for new conversations
6. **Voice Playback**: Replay TTS responses
7. **Conversation Sharing**: Share specific conversations
8. **Advanced Photo Viewer**: Zoom, annotations, etc.

### Integration Ideas
1. **External APIs**: Send data to third-party services
2. **Database Storage**: Persist conversations across sessions
3. **Multi-user Dashboard**: Admin view of all users
4. **Real-time Collaboration**: Multiple users viewing same data
5. **AI Insights**: Analytics on conversation patterns

## 📝 Code Organization

The webview system is organized within `src/index.ts`:

- **Lines 16-30**: Interface definitions
- **Lines 70-153**: Express route setup
- **Lines 154-481**: React UI HTML generation
- **Lines 482-571**: Session handling with webview integration
- **Lines 599-672**: Request processing with data storage
- **Lines 781-818**: Results processing with photo handling

This single-file approach keeps everything centralized while remaining maintainable and extensible. 