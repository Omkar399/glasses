import { AppServer, AppSession, PhotoData } from '@mentra/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error('PACKAGE_NAME is not set in .env file'); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error('MENTRAOS_API_KEY is not set in .env file'); })();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? (() => { throw new Error('GEMINI_API_KEY is not set in .env file'); })();
const PORT = parseInt(process.env.PORT || '3000');

/**
 * SUPER OPTIMIZED Voice Assistant App with Enhanced Async/Await
 * - Robust promise handling with retries
 * - Non-blocking asynchronous operations
 * - Fail-safe async patterns
 */
class HeyMentraVoiceAssistant extends AppServer {
  private gemini: GoogleGenerativeAI;
  private isProcessingRequest = false;
  private requestQueue: Array<{ question: string; session: AppSession; userId: string; timestamp: number }> = [];
  private activePhotoRequests: Map<string, boolean> = new Map(); // Track active photo requests per user
  private lastPhotoTime: Map<string, number> = new Map(); // Track last photo time per user

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: PORT,
    });

    // Initialize Gemini AI
    this.gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
    
    this.logger.info(`🚀 OPTIMIZED Hey Mentra Voice Assistant initialized`);
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    this.logger.info(`🎙️ Session started for user ${userId} (sessionId: ${sessionId})`);
    
    // Initialize user state
    this.activePhotoRequests.set(userId, false);
    this.lastPhotoTime.set(userId, 0);
    
    // Show welcome message immediately (non-blocking)
    setImmediate(() => {
      try {
        session.layouts.showTextWall("Hey Mentra is ready! Say 'Hey Mentra' + your question.");
        this.logger.info(`✅ Welcome message shown for user ${userId}`);
      } catch (error) {
        this.logger.error(`❌ Failed to show welcome message for user ${userId}:`, error);
      }
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
          session.layouts.showTextWall("Voice assistant is listening for 'Hey Mentra'...", {durationMs: 3000});
        }
      });
      
      this.logger.info(`✅ Button listener set up successfully for user ${userId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to set up button listener for user ${userId}:`, error);
    }

    // Set up transcription listener (synchronous like camera stream example)
    try {
      session.events.onTranscription((data) => {
        try {
          this.logger.debug(`🎤 Transcription received for user ${userId}: isFinal=${data.isFinal}, text="${data.text}"`);
          
          if (!data.isFinal) return;

          const spokenText = data.text.toLowerCase().trim();
          this.logger.info(`🎤 Final transcription for user ${userId}: "${spokenText}"`);
          
          // Quick wake word detection
          if (this.detectWakeWord(spokenText)) {
            const question = this.extractQuestion(spokenText);
            this.logger.info(`✨ Wake word detected for user ${userId}: "${question}"`);
            
            // Non-blocking queue processing
            setImmediate(async () => {
              try {
                await this.processRequest(question, session, userId);
              } catch (error) {
                this.logger.error(`❌ Failed to process request for user ${userId}:`, error);
              }
            });
          } else {
            this.logger.debug(`🔇 No wake word detected in: "${spokenText}"`);
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

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    // Clean up user state
    this.activePhotoRequests.delete(userId);
    this.lastPhotoTime.delete(userId);
    
    this.logger.info(`🎙️ Session stopped for user ${userId}, reason: ${reason}`);
  }

  /**
   * ENHANCED: Async queue-based request processing
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
   * ENHANCED: Fully async queue processing with better error isolation
   */
  private async processQueueAsync(): Promise<void> {
    if (this.requestQueue.length === 0 || this.isProcessingRequest) return;
    
    this.isProcessingRequest = true;
    const request = this.requestQueue.shift()!;
    
    try {
      // Show immediate feedback (non-blocking)
      this.showFeedbackAsync(request.session, "Processing...", 1000);
      
      // ENHANCED PARALLEL PROCESSING with better promise handling
      const parallelOperations = await this.executeParallelOperations(request, request.userId);
      
      // Process results with fallback chain
      const finalResponse = await this.processResults(parallelOperations, request.question);
      
      // ENHANCED TTS with retry mechanism
      await this.speakResponseWithRetry(request.session, finalResponse);
      
    } catch (error) {
      this.logger.error(`❌ Request failed:`, error);
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
          model: "gemini-1.5-flash",
          generationConfig: {
            maxOutputTokens: 100,
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
    question: string
  ): Promise<string> {
    const [photoResult, textOnlyResult] = results;
    
    // Try photo processing first if available
    if (photoResult.status === 'fulfilled' && photoResult.value) {
      this.logger.info(`📸 Photo captured, processing with vision...`);
      
      try {
        return await this.safeVisionProcessing(question, photoResult.value);
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
}

// Start the server
const app = new HeyMentraVoiceAssistant();
app.start().catch(console.error); 