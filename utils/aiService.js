const { OpenAIClient, AzureKeyCredential } = require('@azure/openai');

// Create Azure OpenAI client
const createOpenAIClient = () => {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  
  if (!endpoint || !apiKey) {
    throw new Error('Azure OpenAI credentials not configured');
  }
  
  return new OpenAIClient(endpoint, new AzureKeyCredential(apiKey));
};

/**
 * Process message with Azure OpenAI
 * @param {string} message - User message
 * @param {Array} conversationHistory - Previous messages in the conversation
 * @param {Object} user - User object for context
 */
const processWithAzureOpenAI = async (message, conversationHistory, user) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || 'gpt-35-turbo';
    
    // System message to provide context
    const systemMessage = {
      role: 'system',
      content: `You are an assistant for the Employee Scheduling System. You help employees with their schedules, locations, and work-related questions.
      The employee you're talking to is ${user.name}, who works as a ${user.position || 'staff member'} in the ${user.department || 'company'}.
      Be helpful, concise, and friendly. If you don't know the answer to a question, suggest that the employee contact their administrator.
      For schedule-related questions, the system will handle those separately with database queries.`
    };
    
    // Combine system message with conversation history
    const messages = [systemMessage, ...conversationHistory];
    
    // Call Azure OpenAI API
    const result = await client.getChatCompletions(deploymentId, messages, {
      temperature: 0.7,
      maxTokens: 800
    });
    
    // Extract and return the response
    if (result.choices && result.choices.length > 0) {
      return result.choices[0].message.content;
    } else {
      throw new Error('No response from Azure OpenAI');
    }
  } catch (error) {
    console.error('Azure OpenAI processing error:', error.message);
    
    // Fallback response if AI processing fails
    return `I'm sorry, I'm having trouble processing your request right now. For schedule-related questions, you can ask "Where do I work today?" or "What's my schedule this week?"`;
  }
};

module.exports = {
  processWithAzureOpenAI
};