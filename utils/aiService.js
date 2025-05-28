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
 * Process a message with Azure OpenAI using chat completions
 * @param {string} message - User message
 * @param {Array} conversationHistory - Previous messages in the conversation
 * @param {Object} user - User context (name, position, department)
 */
export const processWithAzureOpenAI = async (message, conversationHistory, user) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";

    const systemMessage = {
      role: "system",
      content: `You are an assistant for the Employee Scheduling System. You help employees with their schedules, locations, and work-related questions.
The employee you're talking to is ${user.name}, who works as a ${user.position || "staff member"} in the ${user.department || "company"}.
Be helpful, concise, and friendly. If you don't know the answer to a question, suggest that the employee contact their administrator.
For schedule-related questions, the system will handle those separately with database queries.`
    };

    const messages = [systemMessage, ...conversationHistory, { role: "user", content: message }];

    const response = await client.chat.completions.create({
      model: deploymentId,
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    });

    return response.choices?.[0]?.message?.content || "No response from assistant.";
  } catch (error) {
    console.error("Azure OpenAI processing error:", error.message);
    return `I'm sorry, I'm having trouble processing your request right now. Please try again later or contact your admin.`;
  }
};

/**
 * Generate database query parameters from natural language using Azure OpenAI
 * @param {string} message - User message
 * @param {string} intent - Classified intent
 * @param {Object} user - User context
 * @returns {Promise<Object>} - Query parameters for database
 */
export const generateQueryParameters = async (message, intent, user) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";

    const systemMessage = {
      role: "system",
      content: `You are a query parameter generator for an Employee Scheduling System.
      Your task is to extract relevant parameters from the user message based on the detected intent.
      For each intent type, extract the following parameters:
      
      - schedule_query: date (today, tomorrow, specific date, this week, etc.), schedule_id
      - traffic_query: location_id, destination
      - route_query: origin, destination
      - absence_request: start_date, end_date, reason, type (sick, vacation, personal, other)
      - employee_query: query_type (working, absent, all), department, date
      
      Return ONLY a JSON object with the extracted parameters. Do not include any explanations.
      If a parameter cannot be determined, omit it from the response.`
    };

    const messages = [
      systemMessage,
      { role: "user", content: `Intent: ${intent}\nMessage: ${message}` }
    ];

    const response = await client.chat.completions.create({
      model: deploymentId,
      messages,
      temperature: 0.3,
      response_format: { type: "json_object" },
      max_tokens: 500,
    });

    const queryParams = JSON.parse(response.choices?.[0]?.message?.content || "{}");
    return queryParams;
  } catch (error) {
    console.error("Query parameter generation error:", error.message);
    return {}; // Return empty object if generation fails
  }
};

/**
 * Detect multiple intents from a user message using Azure OpenAI
 * @param {string} message - User message
 * @returns {Promise<Array<string>>} - Array of detected intents
 */
export const detectMultipleIntents = async (message) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";

    const systemMessage = {
      role: "system",
      content: `You are an advanced intent detector for an Employee Scheduling System.
      Your task is to identify if a user message contains multiple intents from this list:
      - schedule_query
      - traffic_query
      - route_query
      - absence_request
      - admin_command
      - employee_query
      - general_question
      
      Return ONLY a JSON array of the detected intents. If there is only one intent, the array should have only one element.
      Example: ["schedule_query", "employee_query"]
      If no clear intent is detected, return ["general_question"]`
    };

    const messages = [
      systemMessage,
      { role: "user", content: message }
    ];

    const response = await client.chat.completions.create({
      model: deploymentId,
      messages,
      temperature: 0.3,
      response_format: { type: "json_object" },
      max_tokens: 100,
    });

    const result = JSON.parse(response.choices?.[0]?.message?.content || '{"intents":["general_question"]}');
    return result.intents || ["general_question"];
  } catch (error) {
    console.error("Multiple intent detection error:", error.message);
    return ["general_question"]; // Default to general question if detection fails
  }
};
