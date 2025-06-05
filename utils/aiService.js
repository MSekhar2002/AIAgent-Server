const { AzureOpenAI } = require('openai');
const winston = require('winston');
const Ajv = require('ajv');
const User = require('../models/User');
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

exports.processWithAzureOpenAI = async (message, conversationHistory, user, options = {}) => {
  try {
    const client = createOpenAIClient();
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || 'gpt-4o';
    logger.debug('Processing with Azure OpenAI', { message, userId: user._id });

    const { intent, queryResult, language, userRole, conversationContext } = options;

    let systemPrompt = `
You are a friendly assistant for the Employee Scheduling System, helping employees and admins with schedules, locations, absences, and more. The user is ${user.name}, a ${user.position || 'staff member'} in ${user.department || 'company'}. Respond naturally, as a human would, using the user's name and including follow-up suggestions. Avoid technical jargon or raw data dumps. If unsure, ask for clarification or suggest contacting the admin.
`;

    if (intent && queryResult) {
      systemPrompt += `
Your task is to transform MongoDB query results into a human-like, friendly response based on the intent. The response should:
- Be conversational, natural, and concise.
- Use the user's preferred language (${language || 'en'}).
- Tailor the tone based on user role (${userRole || 'employee'}): formal for admins, friendly for employees.
- Include relevant details from the query result (e.g., schedule titles, dates, locations, names).
- Handle empty results gracefully (e.g., "Looks like you have no shifts today!").
- Avoid technical jargon (e.g., don't mention "ObjectId" or "query").

**Intent**: ${intent}
**Query Result**: ${JSON.stringify(queryResult, null, 2)}
**Context**: ${JSON.stringify(conversationContext || {})}

**Examples**:
- Intent: read, Model: Schedule, Result: [{ title: "Morning Shift", date: "2025-06-06", startTime: "09:00", location: { name: "HQ" } }], Language: en
  Output: "Hey ${user.name}, you have the Morning Shift tomorrow at HQ starting at 9 AM!"
- Intent: read, Model: Schedule, Result: [], Language: en
  Output: "Looks like you have no shifts scheduled today, ${user.name}. Enjoy your day off!"
- Intent: create, Model: Absence, Result: { _id: "123", user: "John", startDate: "2025-06-06", status: "pending" }, Language: en
  Output: "Got it, ${user.name}! Your absence request for tomorrow is submitted and pending approval."
- Intent: read, Model: Schedule, Result: [{ title: "Shift", date: "2025-06-06", startTime: "08:00", location: { name: "Downtown" } }], Language: fr
  Output: "Salut ${user.name} ! Tu as un shift demain à Downtown à 8h00."
`;
    }

    const systemMessage = { role: 'system', content: systemPrompt };
    const mappedHistory = conversationHistory.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.content
    }));

    const messages = [systemMessage, ...mappedHistory, { role: 'user', content: message }];

    const response = await client.chat.completions.create({
      model: deploymentId,
      messages,
      temperature: 0.7,
      max_tokens: 150
    });

    const result = response.choices?.[0]?.message?.content || 'No response from assistant.';
    logger.info('Azure OpenAI response received', { result });
    return result;
  } catch (error) {
    logger.error('Azure OpenAI processing error', { error: error.message, stack: error.stack });
    return `Sorry, ${user.name}, I couldn’t process your request right now. Please try again or contact your admin.`;
  }
};

const currentDate = new Date().toISOString().split('T')[0];

const systemMessage = `
You are an AI assistant for an Employee Scheduling System integrated with WhatsApp. Your role is to interpret natural language commands (text or voice) and generate MongoDB queries or actions for the following Mongoose models: User, Schedule, Location, Absence, Notification, HourTracking, WhatsAppSettings. Respond conversationally, enforcing role-based access and using the provided schemas for accurate query generation.
Current date: ${currentDate}

**Model Schemas** (simplified for query generation):
1. **User**:
- _id: ObjectId
- name: String (required)
- email: String (required, unique)
- phone: String
- role: String (enum: ['admin', 'employee'], required)
- department: String
- position: String
- notificationPreferences: { email: Boolean, whatsapp: Boolean, dailyBriefing: Boolean, briefingTime: String, language: String (enum: ['en', 'fr']) }
- defaultLocation: ObjectId (ref: Location)
- createdAt: Date
- updatedAt: Date
2. **Schedule**:
- _id: ObjectId
- title: String (required)
- description: String
- date: Date (required)
- startTime: String (required)
- endTime: String (required)
- location: ObjectId (ref: Location, required)
- assignedEmployees: [ObjectId] (ref: User)
- createdBy: ObjectId (ref: User, required)
- notificationSent: Boolean
- notificationOptions: { sendEmail: Boolean, sendWhatsapp: Boolean, reminderTime: Number }
- status: String (enum: ['scheduled', 'in-progress', 'completed', 'cancelled'])
- createdAt: Date
- updatedAt: Date
3. **Location**:
- _id: ObjectId
- name: String (required)
- address: String (required)
- city: String (required)
- state: String
- zipCode: String
- country: String (default: 'USA')
- coordinates: { latitude: Number, longitude: Number } (required)
- description: String
- createdBy: ObjectId (ref: User, required)
- active: Boolean (default: true)
- createdAt: Date
- updatedAt: Date
4. **Absence**:
- _id: ObjectId
- user: ObjectId (ref: User, required)
- schedule: ObjectId (ref: Schedule, required)
- startDate: Date (required)
- endDate: Date (required)
- reason: String
- type: String (enum: ['sick', 'vacation', 'personal', 'other'])
- status: String (enum: ['pending', 'approved', 'rejected', 'completed'])
- replacementNeeded: Boolean
- replacementAssigned: Boolean
- replacementUser: ObjectId (ref: User)
- approvedBy: ObjectId (ref: User)
- notificationSent: Boolean
- createdAt: Date
- updatedAt: Date
5. **Notification**:
- _id: ObjectId
- type: String (enum: ['email', 'whatsapp', 'both'])
- recipient: ObjectId (ref: User, required)
- subject: String
- content: String (required)
- relatedTo: String (enum: ['schedule', 'announcement', 'traffic', 'other'])
- relatedId: ObjectId
- status: String (enum: ['pending', 'sent', 'failed', 'delivered', 'read'])
- sentAt: Date
- deliveredAt: Date
- readAt: Date
- createdBy: ObjectId (ref: User, required)
- createdAt: Date
- updatedAt: Date
6. **HourTracking**:
- _id: ObjectId
- user: ObjectId (ref: User, required)
- schedule: ObjectId (ref: Schedule, required)
- date: Date (required)
- hours: Number (required)
- status: String (enum: ['pending', 'approved', 'rejected'])
- approvedBy: ObjectId (ref: User)
- createdAt: Date
- updatedAt: Date
7. **WhatsAppSettings**:
- _id: ObjectId
- enabled: Boolean (default: true)
- autoReplyEnabled: Boolean (default: true)
- welcomeMessage: String
- aiProcessingEnabled: Boolean (default: true)
- maxResponseLength: Number (default: 300)
- aiSystemInstructions: String
- templates: {
   welcomeMessage: { name: String, language: String, components: [Object] },
   scheduleReminder: { name: String, language: String, components: [Object] },
   scheduleChange: { name: String, language: String, components: [Object] },
   generalAnnouncement: { name: String, language: String, components: [Object] }
 }
- createdAt: Date
- updatedAt: Date

**Role-Based Access**:
- **Admins**: Full CRUD on all models, send announcements, request traffic, briefings, hour reports. Require confirmation for delete/update (e.g., "Confirm deletion of schedule 'Morning Shift'").
- **Non-Admins**: Read own data (Schedules, Absences, Notifications, HourTracking) and create absence requests. Restrict queries to { user: $userId }.

**Entity Resolution**:
- Identify entities (users, locations, schedules) by name first (e.g., "John", "HQ", "Morning Shift").
- If multiple matches (e.g., two users named "John"), use phone number to disambiguate (e.g., "John with phone 123-456-7890").
- Return error if name/phone is ambiguous or not found (e.g., "Multiple users named John, please provide phone number").

**Intents and Actions**:
1. **Read**:
- Schedules: "Show my shifts today", "List all schedules at HQ".
- Locations: "What are the locations?", "Details for HQ".
- Absences: "My pending absences", "All absences for John".
- Notifications: "Show my unread messages".
- HourTracking: "My hours this week".
2. **Create**:
- Schedules: "Create a shift tomorrow at 9 AM at HQ with John, Jane".
- Locations: "Add location Downtown at 123 Main St, NY".
- Absences: "I’m sick tomorrow".
- Notifications: "Message John: Meeting at 2 PM".
3. **Update**:
- Schedules: "Change Morning Shift to 10 AM".
- Locations: "Update HQ address to 456 Oak St".
- Absences: "Approve John’s absence", "Reject Jane’s absence: No notice".
4. **Delete**:
- Schedules/Locations: "Delete Morning Shift, confirm: Yes" (soft-delete locations with active: false).
5. **Special**:
- **Daily Briefing**: "Today’s plan" → Summarize schedules, absences, traffic.
- **Traffic**: "Traffic near HQ" → Azure Maps API call.
- **Hours Report**: "Total hours this week" → Aggregate HourTracking.
- **Absence Replacement**: Suggest replacements for absences based on availability.
- **Private Message**: "Message John privately: Be at HQ" → Use generalAnnouncement template outside sessions.
- **Broadcast**: "Announce: Office closed" → Use generalAnnouncement template.

**Meta WhatsApp Templates**:
- 'welcome_message': Sent on user creation.
- 'schedule_reminder': Schedule notifications.
- 'schedule_change': Schedule updates.
- 'general_announcement': Broadcasts or private messages outside 24-hour session.
- Use templates to initiate sessions or send outside active sessions.

**Multi-Language**:
- Detect language (English/French) from keywords (e.g., "bonjour" → French) or User.notificationPreferences.language.
- Respond in detected language using WhatsAppSettings templates or translations.

**Authorization**:
- Admins: User.role === 'admin'.
- Non-Admins: Restrict to own data.
- Confirmation for admin delete/update.

**Query Generation**:
- Use schemas to generate MongoDB queries for Mongoose.
- Resolve names to ObjectIds (e.g., User.findOne({ name }), then User.findOne({ phone })).
- Use aggregations for briefings/hours (e.g., $match, $lookup, $group).
- Traffic: Return action { type: "getTrafficData", coordinates }.
- Absences: Suggest replacements with no conflicting schedules.
- Output: { intent, model, query, response, action, confirmationRequired, language }.

**Examples**:
- Input: "Show my shifts today" (Non-Admin)
Output: { intent: "read", model: "Schedule", query: { assignedEmployees: $userId, date: { $gte: $today, $lt: $tomorrow } }, response: "Your shifts today: ...", language: "en" }
- Input: "Create shift tomorrow at HQ with John" (Admin)
Output: { intent: "create", model: "Schedule", query: { title: "Shift", date: $tomorrow, startTime: "09:00", location: $hqId, assignedEmployees: [$johnId] }, response: "Shift created.", language: "en" }
- Input: "Traffic near HQ" (Admin)
Output: { intent: "traffic", action: { type: "getTrafficData", coordinates: $hqCoordinates }, response: "Checking traffic...", language: "en" }
- Input: "Bonjour, mes horaires aujourd’hui" (Non-Admin, French)
Output: { intent: "read", model: "Schedule", query: { assignedEmployees: $userId, date: { $gte: $today, $lt: $tomorrow } }, response: "Vos horaires aujourd’hui : ...", language: "fr" }

**Constraints**:
- Secure queries, prevent injection.
- Handle synonyms (e.g., "shift" = "schedule").
- User-friendly errors (e.g., "No user named John found").
- Log commands for debugging.

Generate the MongoDB query or action based on input, role, context, and schemas.
`;

const modelSchemas = {
  User: require('../models/User').schema,
  Schedule: require('../models/Schedule').schema,
  Location: require('../models/Location').schema,
  Absence: require('../models/Absence').schema,
  Notification: require('../models/Notification').schema,
  HourTracking: require('../models/HourTracking').schema,
  WhatsAppSettings: require('../models/WhatsAppSettings').schema
};

exports.generateMongoDBQuery = async (userInput, userId, userRole, conversationContext) => {
  try {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    const language = detectLanguage(userInput, user.notificationPreferences.language || 'en');
    logger.debug('Language detected', { input: userInput, language });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const client = createOpenAIClient();
    const simplifiedSchemas = simplifySchemas(modelSchemas);

    // Helper to resolve names to IDs
    const resolveEntity = async (model, name, phone) => {
      let query = { name: new RegExp(`^${name}$`, 'i') };
      let doc = await model.findOne(query);
      if (!doc && phone) {
        doc = await model.findOne({ phone });
      } else if (!doc) {
        const count = await model.countDocuments(query);
        if (count > 1 && !phone) throw new Error(`Multiple ${model.modelName}s named ${name}, please provide phone number`);
      }
      return doc?._id;
    };

    const completion = await client.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT_ID || 'gpt-4o',
      messages: [
        { role: 'system', content: systemMessage.replace('**Model Schemas**', `**Model Schemas**: ${JSON.stringify(simplifiedSchemas, null, 2)}`) },
        { role: 'user', content: `User Input: ${userInput}\nRole: ${userRole}\nUser ID: ${userId}\nLanguage: ${language}` }
      ],
      response_format: {
        type: 'json_object',
        schema: {
          type: 'object',
          properties: {
            intent: { type: 'string', enum: ['read', 'create', 'update', 'delete', 'traffic', 'briefing', 'hours', 'message'] },
            model: { type: 'string', enum: ['user', 'schedule', 'location', 'absence', 'notification', 'hourTracking'] }, // Lowercase
            query: { type: 'object' },
            response: { type: 'string' },
            action: { type: 'object' },
            confirmationRequired: { type: 'boolean' },
            language: { type: 'string', enum: ['en', 'fr'] }
          },
          required: ['intent', 'response', 'language']
        }
      }
    });

    let result = JSON.parse(completion.choices[0].message.content);

    // Validate query against schema
    const schema = simplifiedSchemas[result.model];
    if (result.query && schema) {
      const validate = ajv.compile(schema);
      if (!validate(result.query)) {
        logger.warn('Invalid query generated', { errors: validate.errors });
        throw new Error('Generated query does not match schema');
      }
    }

    // Resolve names in query
    if (result.query) {
      if (result.query.assignedEmployees && Array.isArray(result.query.assignedEmployees)) {
        result.query.assignedEmployees = await Promise.all(
          result.query.assignedEmployees.map(async (emp) => await resolveEntity(User, emp.name, emp.phone))
        );
      }
      if (result.query.location) {
        result.query.location = await resolveEntity(Location, result.query.location.name, null);
      }
      if (result.query.user) {
        result.query.user = await resolveEntity(User, result.query.user.name, result.query.user.phone);
      }
      if (result.query.recipient) {
        result.query.recipient = await resolveEntity(User, result.query.recipient.name, result.query.recipient.phone);
      }
    }

    // Restrict non-admin queries
    if (userRole !== 'admin' && result.model !== 'notification' && result.intent !== 'traffic') {
      if (result.intent === 'read') {
        result.query = { ...result.query, [result.model === 'user' ? '_id' : 'user']: userId };
      } else if (result.intent === 'create' && result.model === 'absence') {
        result.query.user = userId;
      } else {
        throw new Error('Unauthorized action for non-admin');
      }
    }

    // Handle special intents
    if (result.intent === 'briefing') {
      result.query = [
        { $match: { date: { $gte: today, $lt: tomorrow }, status: { $ne: 'cancelled' } } },
        { $lookup: { from: 'locations', localField: 'location', foreignField: '_id', as: 'location' } },
        { $unwind: '$location' },
        { $lookup: { from: 'users', localField: 'assignedEmployees', foreignField: '_id', as: 'assignedEmployees' } }
      ];
      result.model = 'schedule';
    } else if (result.intent === 'hours') {
      result.query = [
        { $match: { date: { $gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000), $lt: tomorrow } } },
        { $group: { _id: '$user', totalHours: { $sum: '$hours' } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: '$user' }
      ];
      result.model = 'hourTracking';
    } else if (result.intent === 'message' && !conversationContext.activeSession) {
      result.action = { type: 'sendTemplate', template: 'general_announcement', parameters: [result.query.content] };
    }

    // Absence replacement logic
    if (result.intent === 'create' && result.model === 'absence' && result.query.replacementNeeded) {
      const schedule = await Schedule.findById(result.query.schedule);
      if (schedule) {
        const availableUsers = await User.find({ _id: { $nin: schedule.assignedEmployees }, role: 'employee' });
        result.response = `${result.response} Suggested replacements: ${availableUsers.map(u => u.name).join(', ')}. Reply with a name to assign.`;
        result.action = { type: 'awaitReplacement', absenceId: null }; // Set after creation
      }
    }

    logger.info('Command processed', { userId, userRole, input: userInput, result, language });
    return result;
  } catch (error) {
    logger.error('Query generation error', { error: error.message, stack: error.stack });
    return { intent: 'error', response: `Error: ${error.message}`, language: 'en' };
  }
};

// Add language detection helper
const detectLanguage = (input, defaultLang) => {
  const frenchKeywords = ['bonjour', 'aujourd’hui', 'demain', 'horaires', 'absence'];
  return frenchKeywords.some(kw => input.toLowerCase().includes(kw)) ? 'fr' : defaultLang;
};