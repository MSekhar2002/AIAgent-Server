const { AzureOpenAI } = require('openai');
const winston = require('winston');
const Ajv = require('ajv');
const ajv = new Ajv();
const User = require('../models/User');
const Location = require('../models/Location');
const Team = require('../models/Team');
const mongoose = require('mongoose'); 
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

    // Populate user's team information if it exists
    let teamInfo = '';
    if (user.team) {
      try {
        const team = await Team.findById(user.team).exec();
        if (team) {
          teamInfo = ` They belong to the team "${team.name}".`;
        }
      } catch (err) {
        logger.error('Error fetching team info', { error: err.message });
      }
    }

    const systemMessage = {
      role: 'system',
      content: `You are a friendly assistant for the Employee Scheduling System, helping employees and admins with schedules, locations, absences, and more. The user is ${user.name}, a ${user.position || 'staff member'} in ${user.department || 'company'}.${teamInfo} 
      
      IMPORTANT LANGUAGE INSTRUCTIONS:
      1. Detect the language of the user's message (English or French)
      2. Always respond in the SAME language as the user's input
      3. If the user writes in French, respond entirely in French
      4. If the user writes in English, respond entirely in English
      5. For mixed language inputs, use the dominant language
      
      Respond naturally, as a human would, using the user's name and including follow-up suggestions. Avoid technical jargon or raw data dumps. If unsure, ask for clarification or suggest contacting the admin.`
    };

    // Map conversation history to ensure proper role field
    const mappedHistory = conversationHistory.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.content
    }));

    const messages = [systemMessage, ...mappedHistory, { role: 'user', content: message }];

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

    // Get user's team ID if available
    let teamId = null;
    if (user.team) {
      teamId = user.team;
    }

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
3. Admins can access all data within their team scope:
   - If user has a team (${teamId ? 'yes' : 'no'}), filter by team: ${teamId || 'N/A'}
   - For Schedule, Location, User, WhatsAppSettings: team = ${teamId || 'user.team'}
   - For Absence: join with User to filter by user's team
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
16. For schedule creation queries (e.g., "Create a schedule for <employee names> at <location> on <date> from <start time> to <end time>"), resolve employee names to User _ids and location name to Location _id by querying the respective models case-insensitively. Include any notes in the description field.
17. For schedule creation, set createdBy to the current user's _id, status to 'scheduled', team to the user's team ID (${teamId || 'user.team'}), and include default values for optional fields like notificationOptions.
18. For reference fields like location and assignedEmployees in the Schedule model, provide ObjectIds as strings (e.g., "67efab9372692e5936f97788"), not $lookup operations. Do NOT include $lookup in the data object for write operations; $lookup is only for aggregation pipelines.
- intent: send_announcement
  Description: Admin wants to send a general announcement to a specific user or all users.
  Parameters:
    - toAll: boolean (true if targeting all users, false otherwise)
    - targetUser: string (name of specific user, if not toAll)
    - message: string (announcement content)
    - include data 
  - Examples: "Notify Aryu about meeting" -> { intent: "send_announcement", parameters: { toAll: false, targetUser: "Aryu", message: "Team meeting at 10 AM" } }
             "Tell everyone office closed" -> { intent: "send_announcement", parameters: { toAll: true, message: "Office closed tomorrow" } }
19. For intent: send_announcement, no need of model operation n query object, only intent and parameters are needed in the JSON
Return JSON object:
{
  "model": "string",
  "operation": "read|write|update|delete",
  "query": {
    "pipeline": [] (optional, for aggregation),
    "filter": {} (required, for absence updates use { user: user_id, status: 'pending' } if no absence_id, else { _id }),
    "populate": [] (optional, use ['user', 'approvedBy'] for absence),
    "data": {} (for write),
    "update": {} (for update),
    "employeeNames": [] (optional, array of employee names for schedule creation r updation only),
    "locationName": "" (optional, location name for schedule creation r updation only)
  },
  "intent": "send_announcement" (optional, Admin wants to send a general announcement to a specific user or all users, only for sending messages or notifting, eg. prompt-> "Notify Aryu about meeting" ->eg. field in JSON { intent: "send_announcement", parameters: { toAll: false, targetUser: "Aryu", message: "Team meeting at 10 AM" } }
             "Tell everyone office closed" -> { intent: "send_announcement", parameters: { toAll: true, message: "Office closed tomorrow" } })
  "parameters": "send_announcement" (optional, Admin wants to send a general announcement to a specific user or all users, only for sending messages or notifting, eg. prompt-> "Notify Aryu about meeting" ->eg. field in JSON { intent: "send_announcement", parameters: { toAll: false, targetUser: "Aryu", message: "Team meeting at 10 AM" } }
             "Tell everyone office closed" -> { intent: "send_announcement", parameters: { toAll: true, message: "Office closed tomorrow" } })
}
For absence approve/reject, set status to 'approved' or 'rejected', approvedBy to user._id, and updatedAt to current date. If an employee name is provided (e.g., "Approve Aryu's absence"), query the User model by name to get the user ID and use it in the filter (e.g., { user: targetUser._id, status: 'pending' }). If no name or ID, use the current user's ID.Or, for unclear/help queries:
{
  "unclear": true,
  "help": true,
  "context": "create_schedule|update_user|..." (optional)
}`
    };

    // Map conversation history for query generation
    const mappedHistory = conversationHistory.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.content
    }));

    const userMessage = {
      role: 'user',
      content: `User role: ${user.role}\nUser ID: ${user._id}\nConversation history: ${JSON.stringify(mappedHistory.slice(-5))}\nQuery: ${message}`
    };

    const schema = {
      allOf: [
        {
          if: {
            properties: { operation: { const: 'write' } }
          },
          then: {
            properties: {
              query: {
                required: ['data']
              }
            }
          },
          else: {
            properties: {
              query: {
                required: ['filter']
              }
            }
          }
        }
      ],
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
                update: { type: 'object' },
                employeeName: { type: 'string' }
              }
            }
          },
          required: ['model', 'operation', 'query']
        },
        {
          type: 'object',
          properties: {
            intent: { type: 'string', const: 'send_announcement' },
            parameters: {
              type: 'object',
              properties: {
                toAll: { type: 'boolean' },
                targetUser: { type: 'string', nullable: true },
                message: { type: 'string' }
              },
              required: ['message'],
              oneOf: [
                { properties: { toAll: { const: true } }, required: ['toAll'] },
                { properties: { targetUser: { type: 'string' } }, required: ['targetUser'] }
              ]
            }
          },
          required: ['intent', 'parameters']
        },
        {
          type: 'object',
          properties: {
            unclear: { type: 'boolean', enum: [true] },
            help: { type: 'boolean', enum: [true] },
            context: {
              type: 'string',
              pattern: '^(create|update)_(user|schedule|location|absence|hourTracking|conversation|whatsappSettings)$',
              nullable: true
            },
            missingFields: { type: 'array', items: { type: 'string' } },
            message: { type: 'string', nullable: true }
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
          if (parsed.intent === 'send_announcement') {
            logger.info('Announcement intent detected', { parameters: parsed.parameters });
            return parsed;
          }
          if (parsed.model === 'schedule' && parsed.operation === 'write') {
            const { employeeNames, locationName } = parsed.query;

            if (employeeNames && locationName) {
              // Resolve employee IDs
              const employeeQuery = {
                name: { $in: employeeNames.map(name => new RegExp(`^${name}$`, 'i')) }
              };
              
              // Add team filter for admins if they have a team
              if (user.role === 'admin' && user.team) {
                employeeQuery.team = user.team;
              }
              
              const employees = await User.find(employeeQuery);
              if (employees.length !== employeeNames.length) {
                const foundNames = employees.map(emp => emp.name);
                const missing = employeeNames.filter(name => !foundNames.includes(name));
                logger.warn('Some employees not found', { missing });
                return { error: true, message: `Employees not found: ${missing.join(', ')}` };
              }
              const employeeIds = employees.map(emp => emp._id);

              // Resolve location ID with team filter
              const locationQuery = {
                name: new RegExp(`^${locationName}$`, 'i')
              };
              
              // Add team filter for admins if they have a team
              if (user.role === 'admin' && user.team) {
                locationQuery.team = user.team;
              }
              
              const location = await Location.findOne(locationQuery);
              if (!location) {
                logger.warn('Location not found', { locationName });
                return { error: true, message: `Location "${locationName}" not found` };
              }

              // Parse date and times
              const dateMatch = message.match(/\d{4}-\d{2}-\d{2}/);
              const date = dateMatch ? new Date(dateMatch[0]) : new Date();
              const startTime = new Date(`${dateMatch[0]}T09:00:00Z`);
              const endTime = new Date(`${dateMatch[0]}T17:00:00Z`);
              const note = message.match(/note:\s*['"]([\^'"]+)['"]/)?.[1] || '';

              // Build the schedule data
              parsed.query.data = {
                title: `Schedule for ${employeeNames.join(', ')}`,
                description: note,
                date,
                startTime,
                endTime,
                startTimeString: '9:00 AM',
                endTimeString: '5:00 PM',
                location: location._id,
                assignedEmployees: employeeIds,
                createdBy: user._id,
                team: user.team, // Add team reference
                notificationSent: false,
                notificationOptions: {
                  sendEmail: true,
                  sendWhatsapp: false,
                  reminderTime: 24
                },
                status: 'scheduled',
                requireHourTracking: true,
                allowAutoReplacement: false,
                createdAt: new Date(),
                updatedAt: new Date()
              };

              logger.info('Schedule query updated with resolved IDs', { data: parsed.query.data });
            }
          }
          if (parsed.model === 'absence' && parsed.operation === 'update') {
            const isReject = message.toLowerCase().includes('reject');
            const status = isReject ? 'rejected' : 'approved';
            let targetUserId = user._id;
            if (parsed.query?.employeeName) {
              const targetUserQuery = { 
                name: new RegExp(`^${parsed.query.employeeName}$`, 'i') 
              };
              
              // Add team filter for admins if they have a team
              if (user.role === 'admin' && user.team) {
                targetUserQuery.team = user.team;
              }
              
              const targetUser = await User.findOne(targetUserQuery);
              if (!targetUser) {
                logger.warn('Employee not found by name', { employeeName: parsed.query.employeeName });
                return { error: true, message: `Employee "${parsed.query.employeeName}" not found.` };
              }
              targetUserId = targetUser._id;
            }
            if (!parsed.query.filter._id || parsed.query.filter._id === user._id) {
              logger.debug('Using name-based or user-based filter', { employeeName: parsed.query?.employeeName });
              parsed.query.filter = { user: targetUserId, status: 'pending' };
              parsed.query.populate = ['user', 'approvedBy'];
              parsed.query.update = {
                $set: {
                  status: status,
                  approvedBy: user._id,
                  updatedAt: new Date().toISOString()
                }
              };
            } else {
              parsed.query.populate = ['user', 'approvedBy'];
              parsed.query.update.$set.status = status;
              parsed.query.update.$set.approvedBy = user._id;
              parsed.query.update.$set.updatedAt = new Date().toISOString();
            }
            logger.info('Valid absence update query generated', { parsed });
          }
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
