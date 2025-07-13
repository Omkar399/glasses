import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { PhotoData } from '@mentra/sdk';

/**
 * Interface for stored conversation context
 */
interface ConversationContext {
  id: string;
  timestamp: number;
  userId: string;
  question: string;
  response: string;
  photoPath?: string;
  photoAnalysis?: string;
  taskType?: string;
  stepNumber?: number;
  isCompleted: boolean;
  context: string;
}

/**
 * Interface for mental notes
 */
interface MentalNote {
  id: string;
  timestamp: number;
  userId: string;
  note: string;
  category: string;
  photoPath?: string;
  context: string;
}

/**
 * Interface for search results
 */
interface SearchResult {
  conversations: ConversationContext[];
  notes: MentalNote[];
  photoContexts: Array<{
    photoPath: string;
    analysis: string;
    timestamp: number;
    context: string;
  }>;
}

/**
 * Memory & Context Manager
 * Handles persistent storage of conversations, photos, and contexts
 * Provides tools for Gemini to save and retrieve information
 */
export class MemoryManager {
  private db: Database.Database;
  private dataDir: string;
  private photosDir: string;
  private logger: any;

  constructor(dataDir: string = './data', logger?: any) {
    this.dataDir = dataDir;
    this.photosDir = path.join(dataDir, 'photos');
    this.logger = logger || console;
    
    // Ensure directories exist
    this.ensureDirectories();
    
    // Initialize database
    this.db = new Database(path.join(dataDir, 'memory.db'));
    this.initializeDatabase();
    
    this.logger.info('🧠 Memory Manager initialized');
  }

  /**
   * Ensure required directories exist
   */
  private ensureDirectories(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.photosDir)) {
      fs.mkdirSync(this.photosDir, { recursive: true });
    }
  }

  /**
   * Initialize database schema
   */
  private initializeDatabase(): void {
    // Conversations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        question TEXT NOT NULL,
        response TEXT NOT NULL,
        photo_path TEXT,
        photo_analysis TEXT,
        task_type TEXT,
        step_number INTEGER,
        is_completed BOOLEAN DEFAULT FALSE,
        context TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Mental notes table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mental_notes (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        note TEXT NOT NULL,
        category TEXT NOT NULL,
        photo_path TEXT,
        context TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for faster searching
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_user_timestamp ON conversations(user_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_conversations_task_type ON conversations(task_type);
      CREATE INDEX IF NOT EXISTS idx_mental_notes_user_category ON mental_notes(user_id, category);
    `);

    this.logger.info('🗄️ Database schema initialized');
  }

  /**
   * Save photo to file system and return path
   */
  private savePhoto(photoData: PhotoData, userId: string): string {
    const timestamp = Date.now();
    const extension = photoData.mimeType.includes('jpeg') ? 'jpg' : 'png';
    const filename = `${userId}_${timestamp}.${extension}`;
    const photoPath = path.join(this.photosDir, filename);
    
    fs.writeFileSync(photoPath, photoData.buffer);
    return photoPath;
  }

  /**
   * Save conversation context with optional photo
   */
  public saveConversation(context: Omit<ConversationContext, 'id' | 'photoPath'>, photo?: PhotoData): string {
    const id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    let photoPath: string | undefined;

    // Save photo if provided
    if (photo) {
      photoPath = this.savePhoto(photo, context.userId);
    }

    const stmt = this.db.prepare(`
      INSERT INTO conversations (
        id, timestamp, user_id, question, response, photo_path, 
        photo_analysis, task_type, step_number, is_completed, context
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      context.timestamp,
      context.userId,
      context.question,
      context.response,
      photoPath,
      context.photoAnalysis,
      context.taskType,
      context.stepNumber,
      context.isCompleted ? 1 : 0, // Convert boolean to integer for SQLite
      context.context
    );

    this.logger.info(`💾 Saved conversation: ${id}`);
    return id;
  }

  /**
   * Save mental note with optional photo
   */
  public saveMentalNote(note: Omit<MentalNote, 'id' | 'photoPath'>, photo?: PhotoData): string {
    const id = `note_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    let photoPath: string | undefined;

    // Save photo if provided
    if (photo) {
      photoPath = this.savePhoto(photo, note.userId);
    }

    const stmt = this.db.prepare(`
      INSERT INTO mental_notes (id, timestamp, user_id, note, category, photo_path, context)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      note.timestamp,
      note.userId,
      note.note,
      note.category,
      photoPath,
      note.context
    );

    this.logger.info(`📝 Saved mental note: ${id}`);
    return id;
  }

  /**
   * Search conversations by text query
   */
  public searchConversations(userId: string, query: string, limit: number = 10): ConversationContext[] {
    const stmt = this.db.prepare(`
      SELECT * FROM conversations 
      WHERE user_id = ? AND (
        question LIKE ? OR 
        response LIKE ? OR 
        photo_analysis LIKE ? OR
        task_type LIKE ? OR
        context LIKE ?
      )
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    const searchTerm = `%${query}%`;
    const results = stmt.all(userId, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, limit) as any[];
    
    return results.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      userId: row.user_id,
      question: row.question,
      response: row.response,
      photoPath: row.photo_path,
      photoAnalysis: row.photo_analysis,
      taskType: row.task_type,
      stepNumber: row.step_number,
      isCompleted: Boolean(row.is_completed),
      context: row.context
    }));
  }

  /**
   * Search mental notes by text query
   */
  public searchMentalNotes(userId: string, query: string, limit: number = 10): MentalNote[] {
    const stmt = this.db.prepare(`
      SELECT * FROM mental_notes 
      WHERE user_id = ? AND (
        note LIKE ? OR 
        category LIKE ? OR
        context LIKE ?
      )
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    const searchTerm = `%${query}%`;
    const results = stmt.all(userId, searchTerm, searchTerm, searchTerm, limit) as any[];
    
    return results.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      userId: row.user_id,
      note: row.note,
      category: row.category,
      photoPath: row.photo_path,
      context: row.context
    }));
  }

  /**
   * Get recent conversations for context
   */
  public getRecentConversations(userId: string, limit: number = 5): ConversationContext[] {
    const stmt = this.db.prepare(`
      SELECT * FROM conversations 
      WHERE user_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    const results = stmt.all(userId, limit) as any[];
    
    return results.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      userId: row.user_id,
      question: row.question,
      response: row.response,
      photoPath: row.photo_path,
      photoAnalysis: row.photo_analysis,
      taskType: row.task_type,
      stepNumber: row.step_number,
      isCompleted: Boolean(row.is_completed),
      context: row.context
    }));
  }

  /**
   * Get conversations by task type
   */
  public getConversationsByTask(userId: string, taskType: string): ConversationContext[] {
    const stmt = this.db.prepare(`
      SELECT * FROM conversations 
      WHERE user_id = ? AND task_type = ?
      ORDER BY timestamp DESC
    `);

    const results = stmt.all(userId, taskType) as any[];
    
    return results.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      userId: row.user_id,
      question: row.question,
      response: row.response,
      photoPath: row.photo_path,
      photoAnalysis: row.photo_analysis,
      taskType: row.task_type,
      stepNumber: row.step_number,
      isCompleted: Boolean(row.is_completed),
      context: row.context
    }));
  }

  /**
   * Get photo context by reading the image analysis
   */
  public getPhotoContext(photoPath: string): string | null {
    if (!fs.existsSync(photoPath)) {
      return null;
    }

    // Find conversation or note with this photo
    const convStmt = this.db.prepare('SELECT photo_analysis, context FROM conversations WHERE photo_path = ?');
    const noteStmt = this.db.prepare('SELECT context FROM mental_notes WHERE photo_path = ?');
    
    const convResult = convStmt.get(photoPath) as any;
    if (convResult) {
      return `Photo Analysis: ${convResult.photo_analysis}\nContext: ${convResult.context}`;
    }

    const noteResult = noteStmt.get(photoPath) as any;
    if (noteResult) {
      return `Context: ${noteResult.context}`;
    }

    return null;
  }

  /**
   * Comprehensive search across all data
   */
  public comprehensiveSearch(userId: string, query: string): SearchResult {
    const conversations = this.searchConversations(userId, query, 5);
    const notes = this.searchMentalNotes(userId, query, 5);
    
    // Get photo contexts from conversations
    const photoContexts = conversations
      .filter(conv => conv.photoPath && conv.photoAnalysis)
      .map(conv => ({
        photoPath: conv.photoPath!,
        analysis: conv.photoAnalysis!,
        timestamp: conv.timestamp,
        context: conv.context
      }));

    return {
      conversations,
      notes,
      photoContexts
    };
  }

  /**
   * Get tools definition for Gemini Live
   */
  public getToolsDefinition() {
    return [
      {
        name: "save_mental_note",
        description: "Save a mental note about something important for future reference",
        parameters: {
          type: "object",
          properties: {
            note: {
              type: "string",
              description: "The mental note to save"
            },
            category: {
              type: "string",
              description: "Category of the note (e.g., 'environment', 'preference', 'location', 'task')"
            },
            context: {
              type: "string", 
              description: "Additional context about when/why this note was made"
            }
          }
        }
      },
      {
        name: "search_memory",
        description: "Search through past conversations, notes, and photo contexts",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What to search for (e.g., 'bluetooth', 'kitchen', 'settings menu')"
            },
            type: {
              type: "string",
              description: "Type of search: 'all', 'conversations', 'notes', 'photos'",
              enum: ["all", "conversations", "notes", "photos"]
            }
          }
        }
      },
      {
        name: "get_recent_context",
        description: "Get recent conversation context to understand ongoing tasks",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of recent conversations to retrieve (default: 5)"
            }
          }
        }
      }
    ];
  }

  /**
   * Handle tool calls from Gemini
   */
  public async handleToolCall(toolName: string, args: any, userId: string, currentPhoto?: PhotoData): Promise<any> {
    try {
      switch (toolName) {
        case 'save_mental_note':
          const noteId = this.saveMentalNote({
            timestamp: Date.now(),
            userId,
            note: args.note,
            category: args.category,
            context: args.context || ''
          }, currentPhoto);
          
          return {
            success: true,
            message: `Mental note saved: ${args.note}`,
            noteId
          };

        case 'search_memory':
          const searchResults = this.comprehensiveSearch(userId, args.query);
          
          return {
            success: true,
            results: searchResults,
            summary: `Found ${searchResults.conversations.length} conversations, ${searchResults.notes.length} notes, ${searchResults.photoContexts.length} photo contexts`
          };

        case 'get_recent_context':
          const recentConversations = this.getRecentConversations(userId, args.limit || 5);
          
          return {
            success: true,
            conversations: recentConversations,
            summary: `Retrieved ${recentConversations.length} recent conversations`
          };

        default:
          return {
            success: false,
            error: `Unknown tool: ${toolName}`
          };
      }
    } catch (error) {
      this.logger.error(`❌ Memory tool error:`, error);
      return {
        success: false,
        error: `Tool execution failed: ${(error as Error).message}`
      };
    }
  }

  /**
   * Close database connection
   */
  public close(): void {
    this.db.close();
    this.logger.info('🧠 Memory Manager closed');
  }
} 