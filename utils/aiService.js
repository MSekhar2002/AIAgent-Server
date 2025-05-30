import { AzureOpenAI } from "openai";

const createOpenAIClient = () => {
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;

  if (!apiKey || !endpoint) {
    throw new Error("Azure OpenAI credentials not configured");
  }

  return new AzureOpenAI({
    apiKey,
    endpoint,
    apiVersion: "2025-01-01-preview",
    defaultQuery: { "api-version": "2025-01-01-preview" },
    defaultHeaders: { "api-key": apiKey },
  });
};

export const processWithAzureOpenAI = async (message, conversationHistory, user) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";

    const systemMessage = {
      role: "system",
      content: `You are an assistant for the Employee Scheduling System. You help employees with their schedules, locations, and work-related questions.
The employee is ${user.name}, a ${user.position || "staff member"} in ${user.department || "company"}.
Be helpful, concise, and friendly. If unsure, suggest contacting the administrator.`
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
    return "Error processing your request. Please try again or contact your admin.";
  }
};

export const generateMongoDBQuery = async (message, user, modelSchemas) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "gpt-4o";

    const simplifiedSchemas = {};
    for (const [modelName, schema] of Object.entries(modelSchemas)) {
      simplifiedSchemas[modelName] = {};
      const paths = schema.paths;
      for (const [pathName, pathConfig] of Object.entries(paths)) {
        if (pathName.startsWith('_')) continue;

        let fieldType = pathConfig.instance;
        let refModel = pathConfig.options?.ref;

        if (fieldType === 'Array' && pathConfig.schema) {
          fieldType = 'Array of Objects';
        } else if (fieldType === 'Array' && pathConfig.caster?.options?.ref) {
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

    const systemMessage = {
      role: "system",
      content: `You are a MongoDB query generator for an Employee Scheduling System.

Available models and schemas:
${JSON.stringify(simplifiedSchemas, null, 2)}

Based on the user's query, generate a MongoDB query or aggregation pipeline. Rules:
1. If user role is not 'admin', restrict queries:
   - User: _id = ${user._id}
   - Schedule: assignedEmployees includes ${user._id}
   - Absence: user = ${user._id}
   - HourTracking: user = ${user._id}
   - Conversation: user = ${user._id}
2. Admins can access all data without restrictions.
3. Determine operation: read, write, update, or delete.
4. For read, use aggregation pipeline or find query with optional populate.
5. For write, provide document to create.
6. For update, provide filter and update object.
7. For delete, provide filter.
8. If unclear, return { unclear: true }.

Return JSON:
- model: Model name (lowercase)
- operation: read, write, update, or delete
- query: Object with:
  - pipeline (for aggregation)
  - filter (for find/delete)
  - populate (array of fields to populate)
  - data (for write)
  - update (for update)`
    };

    const userMessage = {
      role: "user",
      content: `User role: ${user.role}\nUser ID: ${user._id}\nQuery: ${message}`
    };

    const response = await client.chat.completions.create({
      model: deploymentId,
      messages: [systemMessage, userMessage],
      temperature: 0.1,
      response_format: { type: "json_object" },
      max_tokens: 2000,
    });

    const result = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    return result;
  } catch (error) {
    console.error("MongoDB query generation error:", error.message);
    return { error: true, message: "Error generating query." };
  }
};