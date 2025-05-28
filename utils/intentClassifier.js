import { AzureOpenAI } from "openai";

// Create Azure OpenAI client using the modern SDK
const createOpenAIClient = () => {
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  
  if (!apiKey || !endpoint) {
    throw new Error("Azure OpenAI credentials are not configured");
  }

  return new AzureOpenAI({
    apiKey,
    endpoint,
    apiVersion: "2025-01-01-preview",
    defaultQuery: { "api-version": "2025-01-01-preview" },
    defaultHeaders: { "api-key": apiKey },
  });
};

/**
 * Classify user message intent using Azure OpenAI
 * @param {string} message - User message to classify
 * @returns {Promise<string>} - Classified intent
 */
export const classifyIntent = async (message) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";

    const systemMessage = {
      role: "system",
      content: `You are an advanced intent classifier for an Employee Scheduling System. 
      Your task is to classify the user message into one of these intents using natural language understanding:
      
      - schedule_query: Questions or requests about work schedules, shifts, or when/where the user works
        Examples: "What's my schedule today?", "When am I working this week?", "Show me my shifts"
      
      - traffic_query: Questions about traffic, commute times, or travel conditions
        Examples: "How's the traffic to work?", "What's my commute time?", "Is there traffic on my route?"
      
      - route_query: Questions about route options, directions, or best ways to travel
        Examples: "What's the best way to get to work?", "Show me alternative routes", "How do I get to the client site?"
      
      - absence_request: Requests for time off, sick leave, or absence notifications
        Examples: "I need to take tomorrow off", "I'm sick and can't come in", "Request vacation for next week"
      
      - admin_command: Administrative actions like managing users, schedules, or sending notifications
        Examples: "Show me all users", "List today's schedules", "Send a message to everyone", "Show pending absences"
        Note: Classify as admin_command even WITHOUT the /admin prefix if the intent is administrative in nature
      
      - general_question: General questions about the company, policies, or other work-related topics
        Examples: "What are the company holidays?", "Tell me about the dress code", "How does the bonus system work?"
      
      Respond ONLY with the intent category name, nothing else. Focus on understanding the semantic meaning rather than looking for specific keywords or prefixes.`
    };

    const messages = [
      systemMessage,
      { role: "user", content: message }
    ];

    const response = await client.chat.completions.create({
      model: deploymentId,
      messages,
      temperature: 0.3, // Lower temperature for more deterministic responses
      max_tokens: 20, // Short response needed
    });

    const intent = response.choices?.[0]?.message?.content?.trim().toLowerCase() || "general_question";
    
    // Validate that the response is one of our expected intents
    const validIntents = [
      "schedule_query", 
      "traffic_query", 
      "route_query", 
      "absence_request", 
      "general_question", 
      "admin_command"
    ];
    
    return validIntents.includes(intent) ? intent : "general_question";
  } catch (error) {
    console.error("Intent classification error:", error.message);
    // Default to general_question if classification fails
    return "general_question";
  }
};