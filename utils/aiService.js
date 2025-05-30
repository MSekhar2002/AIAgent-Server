const { AzureOpenAI } = require('openai');
const winston = require('winston');
const Ajv = require('ajv');
const ajv = new Ajv();

// Logger setup
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/aiService.log' }),
    new winston.transports.Console()
  ]
});

// Cached simplified schemas
let cachedSchemas = null;

const createOpenAIClient = () => {
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;

  if (!apiKey || !endpoint) {
    logger.error('Azure OpenAI credentials missing');
    throw new Error('Azure OpenAI credentials not configured');
  }

  return new AzureOpenAI({
    apiKey,
    endpoint,
    apiVersion: '2025-01-01-preview',
    defaultQuery: { 'api-version': '2025-01-01-preview' },
    defaultHeaders: { 'api-key': apiKey }
  });
};

const simplifySchemas = (modelSchemas) => {
  if (cachedSchemas) {
    logger.debug('Using cached schemas');
    return cachedSchemas;
  }

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

  cachedSchemas = simplifiedSchemas;
  logger.info('Schemas simplified and cached');
  return cachedSchemas;
};

exports.processWithAzureOpenAI = async (message, conversationHistory, user) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || 'gpt-4o';
    logger.debug('Processing with Azure OpenAI', { message, userId: user._id });

    const systemMessage = {
      role: 'system',
      content: `You are a friendly assistant for the Employee Scheduling System, helping employees and admins with schedules, locations, absences, and more. The user is ${user.name}, a ${user.position || 'staff member'} in ${user.department || 'company'}. Respond naturally, as a human would, using the user's name and including follow-up suggestions. Avoid technical jargon or raw data dumps. If unsure, ask for clarification or suggest contacting the admin.`
    };

    const messages = [systemMessage, ...conversationHistory, { role: 'user', content: message }];

    const response = await client.chat.completions.create({
      model: deploymentId,
      messages,
      temperature: 0.7,
      max_tokens: 1000
    });

    const result = response.choices?.[0]?.message?.content || 'No response from assistant.';
    logger.info('Azure OpenAI response received', { result });
    return result;
  } catch (error) {
    logger.error('Azure OpenAI processing error', { error: error.message, stack: error.stack });
    return `Sorry, ${user.name}, I couldn’t process your request right now. Please try again or contact your admin.`;
  }
};

exports.generateMongoDBQuery = async (message, user, modelSchemas, conversationHistory) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || 'gpt-4o';
    logger.debug('Generating MongoDB query', { message, userId: user._id });

    const simplifiedSchemas = simplifySchemas(modelSchemas);
    const currentDate = new Date().toISOString().split('T')[0];

    const systemMessage = {
      role: 'system',
      content: `You are a MongoDB query generator for an Employee Scheduling System.

Current date: ${currentDate}

Available models and schemas:
${JSON.stringify(simplifiedSchemas, null, 2)}

Based on the user's query, generate a MongoDB query or aggregation pipeline. Rules:
1. Normalize string queries to be case-insensitive using $regex with 'i' option.
2. If user role is not 'admin', restrict queries:
   - User: _id = ${user._id}
   - Schedule: assignedEmployees includes ${user._id}
   - Absence: user = ${user._id}
   - HourTracking: user = ${user._id}
   - Conversation: user = ${user._id}
3. Admins can access all data without restrictions.
4. Handle synonyms (e.g., 'shifts' = 'schedules', 'today' = current date).
5. For date queries (e.g., 'today'), use $gte and $lt for ranges.
6. Determine operation: read, write, update, or delete.
7. For read, use find query with filter if pipeline is not needed; only use aggregation pipeline if complex operations (e.g., $lookup, $group) are required.
8. For write, provide document to create.
9. For update, provide filter and update object.
10. For delete, provide filter.
11. If unclear or the query asks what the system can do (e.g., 'what can you do'), return { unclear: true, help: true }.
12. If the query asks about details needed to create or update a record (e.g., 'what do you need to create a schedule'), return { unclear: true, help: true, context: "create_<model>" } or { unclear: true, help: true, context: "update_<model>" }.
13. If the query is 'who am I', return a read query for the User model with filter { _id: ${user._id} }.
14. Include all fields for 'all details' queries and populate references.
15. Ensure pipeline is non-empty if aggregation is used; otherwise, use filter with find.

Return JSON:
{
  "model": "model_name",
  "operation": "read|write|update|delete",
  "query": {
    "pipeline": [] (for aggregation, non-empty if used),
    "filter": {} (for find/delete),
    "populate": [] (fields to populate),
    "data": {} (for write),
    "update": {} (for update)
  }
}
Or, for unclear/help queries:
{
  "unclear": true,
  "help": true,
  "context": "create_schedule|update_user|..." (optional)
}`
    };

    const userMessage = {
      role: 'user',
      content: `User role: ${user.role}\nUser ID: ${user._id}\nConversation history: ${JSON.stringify(conversationHistory.slice(-5))}\nQuery: ${message}`
    };

    const schema = {
      oneOf: [
        {
          type: 'object',
          properties: {
            model: { type: 'string' },
            operation: { type: 'string', enum: ['read', 'write', 'update', 'delete'] },
            query: {
              type: 'object',
              properties: {
                pipeline: { type: 'array' },
                filter: { type: 'object' },
                populate: { type: 'array', items: { type: 'string' } },
                data: { type: 'object' },
                update: { type: 'object' }
              },
              required: ['filter', 'populate']
            }
          },
          required: ['model', 'operation', 'query']
        },
        {
          type: 'object',
          properties: {
            unclear: { type: 'boolean', enum: [true] },
            help: { type: 'boolean', enum: [true] },
            context: { type: 'string', pattern: '^(create|update)_(user|schedule|location|absence|hourTracking|conversation|whatsappSettings)$', nullable: true }
          },
          required: ['unclear', 'help']
        }
      ]
    };

    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logger.debug(`Attempt ${attempt} to generate query`);
        response = await client.chat.completions.create({
          model: deploymentId,
          messages: [systemMessage, userMessage],
          temperature: 0.1,
          response_format: { type: 'json_object' },
          max_tokens: 1000
        });

        const rawContent = response.choices?.[0]?.message?.content || '{}';
        logger.debug('Raw Azure OpenAI response', { rawContent });

        const parsed = JSON.parse(rawContent);
        const validate = ajv.compile(schema);
        if (validate(parsed)) {
          if (parsed.operation === 'read' && parsed.query?.pipeline && parsed.query.pipeline.length === 0) {
            logger.debug('Empty pipeline detected, defaulting to find query');
            parsed.query.pipeline = null;
          }
          logger.info('Valid query generated', { parsed });
          return parsed;
        } else {
          logger.warn('Invalid JSON schema', { errors: validate.errors });
        }
      } catch (err) {
        logger.error(`Attempt ${attempt} failed`, { error: err.message, stack: err.stack });
      }
    }

    logger.error('All query generation attempts failed');
    return { error: true, message: 'Failed to generate valid query after retries' };
  } catch (error) {
    logger.error('MongoDB query generation error', { error: error.message, stack: error.stack });
    return { error: true, message: 'Error generating query' };
  }
};