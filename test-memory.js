const { MemoryManager } = require('./dist/memory-manager');

async function testMemoryManager() {
  console.log('🧠 Testing Memory Manager...');
  
  // Initialize memory manager
  const memory = new MemoryManager('./test-data');
  
  // Test saving a conversation
  const conversationId = memory.saveConversation({
    timestamp: Date.now(),
    userId: 'test-user',
    question: 'Help me connect Bluetooth',
    response: 'I can see your phone screen. First, open Settings.',
    photoAnalysis: 'Phone home screen with various app icons visible',
    taskType: 'bluetooth-setup',
    stepNumber: 1,
    isCompleted: false,
    context: 'User is trying to connect wireless headphones'
  });
  
  console.log('✅ Saved conversation:', conversationId);
  
  // Test saving a mental note
  const noteId = memory.saveMentalNote({
    timestamp: Date.now(),
    userId: 'test-user',
    note: 'User prefers to use voice commands over touch',
    category: 'preference',
    context: 'Observed during Bluetooth setup task'
  });
  
  console.log('✅ Saved mental note:', noteId);
  
  // Test searching
  const searchResults = memory.comprehensiveSearch('test-user', 'bluetooth');
  console.log('🔍 Search results for "bluetooth":', {
    conversations: searchResults.conversations.length,
    notes: searchResults.notes.length,
    photoContexts: searchResults.photoContexts.length
  });
  
  // Test getting recent context
  const recentConversations = memory.getRecentConversations('test-user', 3);
  console.log('📝 Recent conversations:', recentConversations.length);
  
  // Test tool calls
  const toolResult = await memory.handleToolCall('save_mental_note', {
    note: 'Kitchen has good lighting for visual tasks',
    category: 'environment',
    context: 'User was cooking when this was observed'
  }, 'test-user');
  
  console.log('🔧 Tool call result:', toolResult);
  
  // Clean up
  memory.close();
  console.log('🧹 Test completed!');
}

testMemoryManager().catch(console.error); 