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
      
      Return a JSON object with an 'intents' property containing an array of the detected intents.
      Example: {"intents": ["schedule_query", "employee_query"]}
      If there is only one intent, the array should have only one element.
      If no clear intent is detected, return {"intents": ["general_question"]}`
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

    try {
      const content = response.choices?.[0]?.message?.content || '{"intents":["general_question"]}';
      
      // Handle different response formats
      try {
        const result = JSON.parse(content);
        // Check if result has intents property, otherwise assume the response itself is the array
        if (Array.isArray(result)) {
          return result;
        } else if (result.intents && Array.isArray(result.intents)) {
          return result.intents;
        } else {
          console.log("Unexpected response format in detectMultipleIntents:", content);
          return ["general_question"];
        }
      } catch (parseError) {
        console.error("JSON parsing error in detectMultipleIntents:", parseError.message);
        
        // Try to extract array from malformed JSON if possible
        if (content.includes('[') && content.includes(']')) {
          try {
            const arrayMatch = content.match(/\[(.*?)\]/s);
            if (arrayMatch && arrayMatch[1]) {
              const items = arrayMatch[1].split(',').map(item => {
                // Clean up and extract intent names
                return item.trim().replace(/["']/g, '').trim();
              }).filter(Boolean);
              
              if (items.length > 0) {
                return items;
              }
            }
          } catch (extractError) {
            console.error("Failed to extract intents from malformed JSON:", extractError.message);
          }
        }
        
        return ["general_question"];
      }
    } catch (error) {
      console.error("Error processing intent detection response:", error.message);
      return ["general_question"];
    }
  } catch (error) {
    console.error("Multiple intent detection error:", error.message);
    return ["general_question"]; // Default to general question if detection fails
  }
};

/**
 * Generate MongoDB aggregation pipeline from natural language using Azure OpenAI
 * @param {string} message - User message
 * @param {Object} user - User context
 * @param {Object} modelSchemas - Object containing all available Mongoose model schemas
 * @returns {Promise<Object>} - Object with model name and aggregation pipeline
 */
/**
 * Classify admin commands using Azure OpenAI
 * @param {string} command - Admin command message
 * @returns {Promise<Object>} - Object with action and parameters
 */
export const classifyAdminCommand = async (command) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";
    
    const systemMessage = {
      role: "system",
      content: `You are an admin command classifier for an Employee Scheduling System.
      
      Your task is to classify admin commands into specific actions and extract relevant parameters.
      
      Available admin command actions:
      - help: Show available admin commands
      - users: List all users in the system
      - user_query: Query information about a specific user
      - schedules: Show schedules (today's or for a specific date)
      - broadcast: Send a message to all users
      - notify: Send a message to a specific user
      - status: Show system status
      - absences: Show absence requests (all or pending)
      - approve: Approve an absence request
      - reject: Reject an absence request
      - collection_query: General database query
      
      For each action, extract relevant parameters such as:
      - user_id or user_name for user-specific commands
      - message content for broadcast or notify commands
      - date for schedule queries
      - absence_id for approve/reject commands
      
      Return a JSON object with:
      - action: The classified admin command action
      - parameters: An object containing extracted parameters relevant to the action
      
      If the command cannot be classified, set action to "unknown".`
    };
    
    const messages = [
      systemMessage,
      { role: "user", content: command }
    ];
    
    const response = await client.chat.completions.create({
      model: deploymentId,
      messages,
      temperature: 0.3,
      response_format: { type: "json_object" },
      max_tokens: 500,
    });
    
    try {
      const content = response.choices?.[0]?.message?.content || '{"action":"unknown"}';
      const result = JSON.parse(content);
      
      return result;
    } catch (parseError) {
      console.error("JSON parsing error in classifyAdminCommand:", parseError.message);
      return { action: "unknown", error: parseError.message };
    }
  } catch (error) {
    console.error("Admin command classification error:", error.message);
    return { action: "unknown", error: error.message };
  }
};

export const generateMongoDBPipeline = async (message, user, modelSchemas) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";

    // Convert model schemas to a simplified format for the prompt
    const simplifiedSchemas = {};
    for (const [modelName, schema] of Object.entries(modelSchemas)) {
      simplifiedSchemas[modelName] = {};
      const paths = schema.schema.paths;
      for (const [pathName, pathConfig] of Object.entries(paths)) {
        // Skip internal Mongoose fields
        if (pathName.startsWith('_')) continue;
        
        // Get the type and reference information
        let fieldType = pathConfig.instance;
        let refModel = null;
        
        if (pathConfig.options && pathConfig.options.ref) {
          refModel = pathConfig.options.ref;
        }
        
        // Handle array types
        if (fieldType === 'Array' && pathConfig.schema) {
          fieldType = 'Array of Objects';
        } else if (fieldType === 'Array' && pathConfig.caster && pathConfig.caster.options && pathConfig.caster.options.ref) {
          fieldType = `Array of ${pathConfig.caster.options.ref} references`;
          refModel = pathConfig.caster.options.ref;
        }
        
        simplifiedSchemas[modelName][pathName] = {
          type: fieldType,
          ref: refModel,
          enum: pathConfig.enumValues || null,
          required: pathConfig.isRequired || false
        };
      }
    }

    // Create a system message that explains the task and provides the schema information
    const systemMessage = {
      role: "system",
      content: `You are a MongoDB aggregation pipeline generator for an Employee Scheduling System.
      
      Your task is to convert natural language queries into MongoDB aggregation pipelines.
      
      Here are the available models and their schemas:
      ${JSON.stringify(simplifiedSchemas, null, 2)}
      
      Based on the user's query, determine which model(s) to query and generate the appropriate MongoDB aggregation pipeline.
      
      IMPORTANT RULES:
      1. If the user is not an admin (role is not 'admin'), restrict results to only their own data by adding appropriate filters:
         - For User model: _id must match the user's ID (${user._id})
         - For Schedule model: assignedEmployees must include the user's ID
         - For Absence model: user field must match the user's ID
         - For HourTracking model: user field must match the user's ID
         - For Conversation model: user field must match the user's ID
      
      2. If the user is an admin, return full results based on the query without these restrictions.
      
      3. If the query is unclear or ambiguous, return null for both model and pipeline.
      
      4. For date-based queries, use proper MongoDB date operators.
      
      5. Always include appropriate $lookup stages to populate referenced fields when they would be useful for the query.
      
      6. For location queries (e.g., "all locations", "list locations", "show locations", "give locations"), use the location model and return all locations sorted by name.
      
      7. For absence approval queries, ensure the Absence model is used with appropriate filters for pending absences.
      
      Return a JSON object with:
      - model: The primary model name to query (lowercase, singular form as used in the schema)
      - pipeline: The MongoDB aggregation pipeline array
      - additionalModels: Optional array of objects with {model, pipeline} for additional queries if needed
      
      If multiple models need to be queried separately, include them in the additionalModels array.`
    };

    const userMessage = {
      role: "user",
      content: `User role: ${user.role}\nUser ID: ${user._id}\nQuery: ${message}`
    };

    const messages = [systemMessage, userMessage];

    const response = await client.chat.completions.create({
      model: deploymentId,
      messages,
      temperature: 0.1, // Low temperature for more deterministic responses
      response_format: { type: "json_object" },
      max_tokens: 2000,
    });

    try {
      const content = response.choices?.[0]?.message?.content || '{}';
      const result = JSON.parse(content);
      
      // Validate the response structure
      if (!result.model && !result.pipeline && (!result.additionalModels || result.additionalModels.length === 0)) {
        console.log("Query unclear, returning null");
        return { unclear: true, message: "Your message is not clear. Please specify exactly what you want." };
      }
      
      return result;
    } catch (parseError) {
      console.error("JSON parsing error in generateMongoDBPipeline:", parseError.message);
      return { error: true, message: "Error parsing the generated pipeline." };
    }
  } catch (error) {
    console.error("MongoDB pipeline generation error:", error.message);
    return { error: true, message: "Error generating the MongoDB pipeline." };
  }
};
