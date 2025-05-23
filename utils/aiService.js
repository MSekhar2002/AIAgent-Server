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
