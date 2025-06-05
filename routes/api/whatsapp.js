const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const axios = require('axios').default;
const mongoose = require('mongoose');
const winston = require('winston');
const retry = require('async-retry');
const User = require('../../models/User');
const Schedule = require('../../models/Schedule');
const Location = require('../../models/Location');
const Conversation = require('../../models/Conversation');
const Absence = require('../../models/Absence');
const HourTracking = require('../../models/HourTracking');
const WhatsAppSettings = require('../../models/WhatsAppSettings');
const { sendWhatsAppMessage, sendWhatsAppTemplate } = require('../../utils/whatsappService');
const { processWithAzureOpenAI, generateMongoDBQuery } = require('../../utils/aiService');
const { convertSpeechToText } = require('../../utils/speechService');

// Logger setup
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/whatsapp.log' }),
    new winston.transports.File({ filename: 'logs/commands.log' }),
    new winston.transports.Console()
  ]
});


const downloadAudio = async (audioId) => {
  return await retry(
    async () => {
      try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        if (!accessToken) {
          logger.error('WhatsApp access token missing');
          throw new Error('WhatsApp access token not configured');
        }

        // Get audio metadata (URL) from Meta API
        const response = await axios.get(`https://graph.facebook.com/v23.0/${audioId}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        const audioUrl = response.data.url;
        if (!audioUrl) {
          logger.error('Audio URL not found', { audioId });
          throw new Error('Failed to retrieve audio URL');
        }

        // Download audio file as a buffer
        const audioResponse = await axios.get(audioUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
          responseType: 'arraybuffer'
        });

        const audioBuffer = Buffer.from(audioResponse.data);
        logger.info('Audio downloaded successfully', { audioId, bufferSize: audioBuffer.length });

        return audioBuffer;
      } catch (error) {
        logger.error('Failed to download audio', {
          audioId,
          error: error.message,
          status: error.response?.status,
          stack: error.stack
        });
        throw error;
      }
    },
    {
      retries: 3,
      factor: 2,
      minTimeout: 1000,
      onRetry: (err, attempt) => logger.warn('Retrying audio download', { attempt, error: err.message })
    }
  );
};

// Model schemas for Azure OpenAI
const modelSchemas = {
  user: User.schema,
  schedule: Schedule.schema,
  location: Location.schema,
  conversation: Conversation.schema,
  absence: Absence.schema,
  hourTracking: HourTracking.schema,
  whatsappSettings: WhatsAppSettings.schema
};

// @route   GET api/whatsapp/webhook
// @desc    Handle Meta webhook verification
// @access  Public
router.get('/webhook', (req, res) => {
  logger.debug('Received webhook verification request', { query: req.query });
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    logger.info('Webhook verification successful');
    return res.status(200).send(challenge);
  }
  logger.warn('Webhook verification failed', { token });
  return res.sendStatus(403);
});

// @route   POST api/whatsapp/webhook
// @desc    Receive and process WhatsApp messages
// @access  Public
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (!body.entry || !body.entry[0].changes || !body.entry[0].changes[0].value.messages) {
      logger.warn('Invalid webhook payload', { body });
      return res.sendStatus(400);
    }

    const message = body.entry[0].changes[0].value.messages[0];
    const phoneNumber = body.entry[0].changes[0].value.contacts[0].wa_id;
    const user = await User.findOne({ phone: phoneNumber });

    if (!user) {
      await sendWhatsAppMessage(phoneNumber, 'Please register with the system first.');
      return res.sendStatus(200);
    }

    let conversation = await Conversation.findOne({ user: user._id, active: true });
    if (!conversation) {
      conversation = new Conversation({ user: user._id, platform: 'whatsapp' });
    }

    const isActiveSession = conversation.lastActivity > new Date(Date.now() - 24 * 60 * 60 * 1000);
    let userInput = message.type === 'text' ? message.text.body : null;

    if (message.type === 'audio') {
      const audioId = message.audio.id;
      const audioBuffer = await downloadAudio(audioId);
      userInput = await convertSpeechToText(audioBuffer);
      conversation.messages.push({
        sender: 'user',
        content: userInput,
        timestamp: new Date(),
        originalAudio: audioBuffer
      });
    } else {
      conversation.messages.push({
        sender: 'user',
        content: userInput,
        timestamp: new Date()
      });
    }

    conversation.lastActivity = new Date();
    await conversation.save();

    const result = await generateMongoDBQuery(userInput, user._id, user.role, {
      language: user.notificationPreferences.language,
      activeSession: isActiveSession
    });

    let response = result.response;
    const conversationHistory = conversation.messages;

    if (result.confirmationRequired) {
      conversation.context.confirmation = { intent: result.intent, model: result.model, query: result.query };
      await conversation.save();
    } else if (userInput.toLowerCase() === 'yes' && conversation.context.confirmation) {
      const { intent, model, query } = conversation.context.confirmation;
      const Model = mongoose.model(model);
      let queryResult;
      if (intent === 'delete') {
        queryResult = await Model.findOneAndDelete(query);
      } else if (intent === 'update') {
        queryResult = await Model.findOneAndUpdate(query.filter, query.update, { new: true });
      }
      response = await processWithAzureOpenAI(
        `Generate a response for ${intent} ${model}`,
        conversationHistory,
        user,
        { intent, queryResult, language: result.language, userRole: user.role, conversationContext: conversation.context }
      );
      conversation.context.confirmation = null;
      await conversation.save();
    } else if (result.intent === 'traffic' && result.action) {
      // Assume getTrafficData exists in traffic.js
      const trafficData = await require('../../utils/trafficService').getTrafficData(result.action.coordinates);
      response = await processWithAzureOpenAI(
        `Generate a response for traffic data`,
        conversationHistory,
        user,
        { intent: 'traffic', queryResult: trafficData, language: result.language, userRole: user.role, conversationContext: conversation.context }
      );
    } else if (result.intent === 'briefing') {
      const schedules = await Schedule.aggregate(result.query);
      response = await processWithAzureOpenAI(
        `Generate a response for daily briefing`,
        conversationHistory,
        user,
        { intent: 'briefing', queryResult: schedules, language: result.language, userRole: user.role, conversationContext: conversation.context }
      );
    } else if (result.intent === 'hours') {
      const hours = await HourTracking.aggregate(result.query);
      response = await processWithAzureOpenAI(
        `Generate a response for hours report`,
        conversationHistory,
        user,
        { intent: 'hours', queryResult: hours, language: result.language, userRole: user.role, conversationContext: conversation.context }
      );
    } else if (result.intent === 'message' && result.action?.type === 'sendTemplate') {
      await sendWhatsAppTemplate(phoneNumber, result.action.template, result.action.parameters);
      response = result.language === 'fr' ? 'Message envoyé avec succès !' : 'Message sent successfully!';
    } else if (result.query) {
      const Model = mongoose.model(result.model);
      let queryResult;
      if (result.intent === 'read') {
        queryResult = await Model.find(result.query).populate('location assignedEmployees');
      } else if (result.intent === 'create') {
        const doc = new Model(result.query);
        queryResult = await doc.save();
        if (result.action?.type === 'awaitReplacement') {
          result.action.absenceId = doc._id; // Update absenceId
          conversation.context.replacement = result.action;
          await conversation.save();
        }
      } else if (result.intent === 'update') {
        queryResult = await Model.findOneAndUpdate(result.query.filter, result.query.update, { new: true });
      }
      response = await processWithAzureOpenAI(
        `Generate a response for ${result.intent} ${result.model}`,
        conversationHistory,
        user,
        { intent: result.intent, queryResult, language: result.language, userRole: user.role, conversationContext: conversation.context }
      );
    }

    if (!isActiveSession && result.intent !== 'message') {
      await sendWhatsAppTemplate(phoneNumber, 'general_announcement', [response]);
    } else {
      await sendWhatsAppMessage(phoneNumber, response);
    }

    conversation.messages.push({
      sender: 'system',
      content: response,
      timestamp: new Date(),
      processed: true
    });
    await conversation.save();

    logger.info('WhatsApp command processed', { userId: user._id, input: userInput, response, language: result.language });
    res.sendStatus(200);
  } catch (error) {
    logger.error('Webhook error', { error: error.message, stack: error.stack });
    await sendWhatsAppMessage(phoneNumber, 'Sorry, something went wrong. Please try again.');
    res.sendStatus(500);
  }
});router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (!body.entry || !body.entry[0].changes || !body.entry[0].changes[0].value.messages) {
      return res.sendStatus(400);
    }

    const message = body.entry[0].changes[0].value.messages[0];
    const phoneNumber = body.entry[0].changes[0].value.contacts[0].wa_id;
    const user = await User.findOne({ phone: phoneNumber });

    if (!user) {
      await sendWhatsAppMessage(phoneNumber, 'Please register with the system first.');
      return res.sendStatus(200);
    }

    let conversation = await Conversation.findOne({ user: user._id, active: true });
    if (!conversation) {
      conversation = new Conversation({ user: user._id, platform: 'whatsapp' });
    }

    const isActiveSession = conversation.lastActivity > new Date(Date.now() - 24 * 60 * 60 * 1000);
    let userInput = message.type === 'text' ? message.text.body : null;

    if (message.type === 'audio') {
      const audioId = message.audio.id;
      const audioBuffer = await downloadAudio(audioId);
      userInput = await convertSpeechToText(audioBuffer);
      conversation.messages.push({
        sender: 'user',
        content: userInput,
        timestamp: new Date(),
        originalAudio: audioBuffer
      });
    } else {
      conversation.messages.push({
        sender: 'user',
        content: userInput,
        timestamp: new Date()
      });
    }

    conversation.lastActivity = new Date();
    await conversation.save();

    const result = await generateMongoDBQuery(userInput, user._id, user.role, {
      language: user.notificationPreferences.language,
      activeSession: isActiveSession
    });

    let response = result.response;

    if (result.confirmationRequired) {
      conversation.context.confirmation = { intent: result.intent, model: result.model, query: result.query };
      await conversation.save();
    } else if (userInput.toLowerCase() === 'yes' && conversation.context.confirmation) {
      const { intent, model, query } = conversation.context.confirmation;
      const Model = mongoose.model(model);
      let queryResult;
      if (intent === 'delete') {
        queryResult = await Model.findOneAndDelete(query);
      } else if (intent === 'update') {
        queryResult = await Model.findOneAndUpdate(query.filter, query.update, { new: true });
      }
      response = await generateConversationalResponse(queryResult, intent, user.role, user._id, result.language, conversation.context);
      conversation.context.confirmation = null;
      await conversation.save();
    } else if (result.intent === 'traffic' && result.action) {
      const trafficData = await getTrafficData(result.action.coordinates);
      response = await generateConversationalResponse(trafficData, 'traffic', user.role, user._id, result.language, conversation.context);
    } else if (result.intent === 'briefing') {
      const schedules = await Schedule.aggregate(result.query);
      response = await generateConversationalResponse(schedules, 'briefing', user.role, user._id, result.language, conversation.context);
    } else if (result.intent === 'hours') {
      const hours = await HourTracking.aggregate(result.query);
      response = await generateConversationalResponse(hours, 'hours', user.role, user._id, result.language, conversation.context);
    } else if (result.intent === 'message' && result.action?.type === 'sendTemplate') {
      await sendWhatsAppTemplate(phoneNumber, result.action.template, result.action.parameters);
      response = result.language === 'fr' ? 'Message envoyé avec succès !' : 'Message sent successfully!';
    } else if (result.query) {
      const Model = mongoose.model(result.model);
      let queryResult;
      if (result.intent === 'read') {
        queryResult = await Model.find(result.query).populate('location assignedEmployees');
      } else if (result.intent === 'create') {
        const doc = new Model(result.query);
        queryResult = await doc.save();
      } else if (result.intent === 'update') {
        queryResult = await Model.findOneAndUpdate(result.query.filter, query.update, { new: true });
      }
      response = await generateConversationalResponse(queryResult, result.intent, user.role, user._id, result.language, conversation.context);
    }

    if (!isActiveSession && result.intent !== 'message') {
      await sendWhatsAppTemplate(phoneNumber, 'general_announcement', [response]);
    } else {
      await sendWhatsAppMessage(phoneNumber, response);
    }

    conversation.messages.push({
      sender: 'system',
      content: response,
      timestamp: new Date(),
      processed: true
    });
    await conversation.save();

    logger.info('WhatsApp command processed', { userId: user._id, input: userInput, response, language: result.language });

    res.sendStatus(200);
  } catch (error) {
    logger.error('Webhook error', { error: error.message, stack: error.stack });
    await sendWhatsAppMessage(phoneNumber, 'Sorry, something went wrong. Please try again.');
    res.sendStatus(500);
  }
});

// Helper to create Meta client
const createMetaClient = () => {
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    logger.error('Meta WhatsApp credentials missing');
    throw new Error('Meta WhatsApp credentials not configured');
  }

  return {
    token,
    phoneNumberId,
    apiUrl: `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`
  };
};

// Helper to generate help message for create/update contexts
const generateHelpMessageForContext = async (user, context, conversationHistory) => {
  const [action, model] = context.split('_');
  const schemas = {
    user: {
      create: {
        name: { type: 'String', required: true },
        email: { type: 'String', required: true },
        password: { type: 'String', required: true },
        phone: { type: 'String', required: true },
        role: { type: 'String', enum: ['admin', 'user'], required: true },
        department: { type: 'String', required: false },
        position: { type: 'String', required: false },
        hourTrackingEnabled: { type: 'Boolean', required: false }
      },
      update: {
        name: { type: 'String', required: false },
        email: { type: 'String', required: false },
        phone: { type: 'String', required: false },
        role: { type: 'String', enum: ['admin', 'user'], required: false },
        department: { type: 'String', required: false },
        position: { type: 'String', required: false },
        hourTrackingEnabled: { type: 'Boolean', required: false }
      }
    },
    schedule: {
      create: {
        startTime: { type: 'Date', required: true },
        endTime: { type: 'Date', required: true },
        assignedEmployees: { type: 'Array of User references', required: true },
        location: { type: 'Location reference', required: true },
        notes: { type: 'String', required: false }
      },
      update: {
        startTime: { type: 'Date', required: false },
        endTime: { type: 'Date', required: false },
        assignedEmployees: { type: 'Array of User references', required: false },
        location: { type: 'Location reference', required: false },
        notes: { type: 'String', required: false }
      }
    },
    location: {
      create: {
        name: { type: 'String', required: true },
        address: { type: 'String', required: true },
        city: { type: 'String', required: true },
        state: { type: 'String', required: false },
        zip: { type: 'String', required: false }
      },
      update: {
        name: { type: 'String', required: false },
        address: { type: 'String', required: false },
        city: { type: 'String', required: false },
        state: { type: 'String', required: false },
        zip: { type: 'String', required: false }
      }
    },
    absence: {
      create: {
        user: { type: 'User reference', required: true },
        startDate: { type: 'Date', required: true },
        endDate: { type: 'Date', required: true },
        reason: { type: 'String', required: true },
        status: { type: 'String', enum: ['pending', 'approved', 'rejected'], required: false }
      },
      update: {
        startDate: { type: 'Date', required: false },
        endDate: { type: 'Date', required: false },
        reason: { type: 'String', required: false },
        status: { type: 'String', enum: ['pending', 'approved', 'rejected'], required: false }
      }
    },
    hourTracking: {
      create: {
        user: { type: 'User reference', required: true },
        date: { type: 'Date', required: true },
        hours: { type: 'Number', required: true },
        description: { type: 'String', required: false }
      },
      update: {
        date: { type: 'Date', required: false },
        hours: { type: 'Number', required: false },
        description: { type: 'String', required: false }
      }
    },
    conversation: {
      create: {
        user: { type: 'User reference', required: true },
        platform: { type: 'String', enum: ['whatsapp', 'voice'], required: true },
        messages: { type: 'Array of Objects', required: false },
        context: { type: 'Object', required: false }
      },
      update: {
        messages: { type: 'Array of Objects', required: false },
        context: { type: 'Object', required: false },
        active: { type: 'Boolean', required: false }
      }
    },
    whatsappSettings: {
      create: {
        webhookUrl: { type: 'String', required: true },
        verifyToken: { type: 'String', required: true },
        enabled: { type: 'Boolean', required: false }
      },
      update: {
        webhookUrl: { type: 'String', required: false },
        verifyToken: { type: 'String', required: false },
        enabled: { type: 'Boolean', required: false }
      }
    }
  };

  const schema = schemas[model]?.[action];
  if (!schema) {
    return await processWithAzureOpenAI(
      `Tell ${user.name} that the request to ${action} ${model} is invalid and suggest checking the model or action.`,
      conversationHistory,
      user
    );
  }

  let message = `To ${action} a ${model}, please provide:\n`;
  for (const [field, config] of Object.entries(schema)) {
    const required = config.required ? ' (required)' : ' (optional)';
    let typeInfo = config.type;
    if (config.enum) typeInfo += ` (one of: ${config.enum.join(', ')})`;
    if (config.ref) typeInfo += ` (ID or name of ${config.ref})`;
    message += `- **${field}**: ${typeInfo}${required}\n`;
  }

  const examples = {
    user: {
      create: `Create user named Priya Sharma with email priya@example.com, phone +919876543210, role user, department Sales,`,
      update: `Update user Priya Sharma’s email to priya.sharma@example.com and role to admin`
    },
    schedule: {
      create: `Create schedule for Aryu at Hyderabad on 2025-06-30 from 9 AM to 5 PM`,
      update: `Update schedule on 2025-06-30 to end at 6 PM`
    },
    location: {
      create: `Create location named Bangalore Office at 123 MG Road, Bangalore`,
      update: `Update Bangalore Office address to 456 MG Road`
    },
    absence: {
      create: `Request absence for Aryu from 2025-07-01 to 2025-07-02 for medical reasons`,
      update: `Update absence for Aryu to end on 2025-07-03`
    },
    hourTracking: {
      create: `Log 8 hours for Aryu on 2025-06-30 for project work`,
      update: `Update hours for Aryu on 2025-06-30 to 7 hours`
    },
    conversation: {
      create: `Start a new conversation for Aryu on WhatsApp`,
      update: `Add a message to Aryu’s conversation`
    },
    whatsappSettings: {
      create: `Set up WhatsApp webhook with URL https://example.com/webhook and token abc123`,
      update: `Update WhatsApp webhook URL to https://newexample.com/webhook`
    }
  };

  message += `\nExample: "${examples[model][action]}"\nTry again with these details, or let me know if you need more help!`;

  return await processWithAzureOpenAI(
    `Explain to ${user.name} how to ${action} a ${model} using this information in a friendly, natural way: ${message}`,
    conversationHistory,
    user
  );
};

// Helper to format query results (used for raw formatting before adding)
const formatResults = (model, results) => {
  let response = `${model.charAt(0).toUpperCase() + model.slice(1)} Details:\n\n`;

  results.forEach((item, index) => {
    response += `${index + 1}. `;
    const cleanItem = item.toObject ? item.toObject() : item;
    Object.entries(cleanItem).forEach(([key, value]) => {
      if (key !== '_id' && key !== '__v' && value != null) {
        if (value instanceof Date) {
          response += `${key}: ${value.toLocaleString()}\n`;
        } else if (Array.isArray(value)) {
          response += `${key}: ${value.map(v => v.name || v).join(', ')}\n`;
        } else if (typeof value === 'object' && value.name) {
          response += `${key}: ${value.name}\n`;
        } else if (typeof value !== 'object') {
          response += `${key}: ${value}\n`;
        }
      }
    });
    response += '\n';
  });

  logger.debug('Formatted results', { model, count: results.length });
  return response;
};

// Admin routes
router.post('/send', [auth, admin], async (req, res) => {
  const { userId, userMessage } = req.body;
  logger.debug('Admin send message request', { userId, userMessage });
  try {
    const user = await User.findById(userId);
    if (!user || !user.phone) {
      logger.warn('User or phone not found', { userId });
      return res.status(404).json({ error: 'User or phone not found' });
    }
    await sendWhatsAppMessage(user.phone, userMessage);
    logger.info('Admin message sent', { userId });
    res.json({ message: 'Message sent' });
  } catch (err) {
    logger.error('Admin send error', { error: err.message });
    res.status(500).send('Server Error');
  }
});

router.get('/conversations', [auth, admin], async (req, res) => {
  logger.debug('Fetching conversations');
  try {
    const conversations = await Conversation.find()
      .populate('user', 'name', 'email', 'phone')
      .sort({ createdAt: -1 });
    logger.info('Conversations retrieved', { count: conversations.length });
    res.json(conversations);
  } catch (err) {
    logger.error('Conversations fetch error', { error: err.message });
    res.status(500).send('Server Error');
  }
});

router.get('/conversations/:id', [auth, admin], async (req, res) => {
  logger.debug('Fetching conversation', { id: req.params.id });
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      logger.warn('Conversation not found', { id: req.params.id });
      return res.status(404).json({ error: 'Conversation not found' });
    }
    logger.info('Conversation retrieved', { id: req.params.id });
    res.json(conversation);
  } catch (err) {
    logger.error('Conversation fetch error', { error: err.message });
    res.status(500).send('Server Error');
  }
});

router.get('/settings', [auth, admin], async (req, res) => {
  logger.debug('Fetching WhatsApp settings');
  try {
    let settings = await WhatsAppSettings.findOne();
    if (!settings) {
      settings = new WhatsAppSettings();
      await settings.save();
      logger.info('Created default WhatsApp settings');
    }
    logger.info('Settings retrieved');
    res.json(settings);
  } catch (err) {
    logger.error('Settings fetch error', { error: err.message });
    res.status(500).send('Server Error');
  }
});

router.put('/settings/update', [auth, admin], async (req, res) => {
  logger.debug('Updating WhatsApp settings', { body: req.body });
  try {
    let settings = await WhatsAppSettings.findOne();
    if (!settings) {
      settings = new WhatsAppSettings();
    }
    Object.assign(settings, req.body);
    settings.updatedAt = Date.now();
    await settings.save();
    logger.info('Settings updated');
    res.json(settings);
  } catch (err) {
    logger.error('Settings update error', { error: err.message });
    res.status(500).send('Server Error');
  }
});

const generateHumanLikeResponse = async (queryResult, intent, userRole, userId, language, conversationContext) => {
  try {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    // Prepare prompt for human-like response
    const prompt = `
You are a conversational AI assistant for an Employee Scheduling System on WhatsApp. Your task is to transform MongoDB query results into a human-like, friendly response. The response should:

- Be conversational, natural, and concise.
- Use the user's preferred language (${language}).
- Tailor the tone based on user role (${userRole}): formal for admins, friendly for employees.
- Include relevant details from the query result (e.g., schedule titles, dates, locations, names).
- Handle empty results gracefully (e.g., "Looks like you have no shifts today!").
- Avoid technical jargon (e.g., don't mention "ObjectId" or "query").

**Intent**: ${intent}
**Query Result**: ${JSON.stringify(queryResult, null, 2)}
**Language**: ${language} (use English for 'en', French for 'fr')
**User Role**: ${userRole}
**Context**: ${JSON.stringify(conversationContext)}

**Examples**:
- Intent: read, Model: Schedule, Result: [{ title: "Morning Shift", date: "2025-06-06", startTime: "09:00", location: { name: "HQ" } }], Language: en
  Output: "Hey, you have the Morning Shift tomorrow at HQ starting at 9 AM!"
- Intent: read, Model: Schedule, Result: [], Language: en
  Output: "Looks like you have no shifts scheduled today. Enjoy your day off!"
- Intent: create, Model: Absence, Result: { _id: "123", user: "John", startDate: "2025-06-06", status: "pending" }, Language: en
  Output: "Got it, John! Your absence request for tomorrow is submitted and pending approval."
- Intent: read, Model: Schedule, Result: [{ title: "Shift", date: "2025-06-06", startTime: "08:00", location: { name: "Downtown" } }], Language: fr
  Output: "Salut ! Tu as un shift demain à Downtown à 8h00."

Generate a human-like response based on the query result, intent, role, and language.
`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Generate a response for the provided query result.` }
      ],
      max_tokens: 150
    });

    const response = completion.choices[0].message.content.trim();
    logger.info('Human-like response generated', { intent, userId, language, response });

    return response;
  } catch (error) {
    logger.error('Failed to generate human-like response', { error: error.message, stack: error.stack });
    return language === 'fr' ? 'Désolé, une erreur s’est produite. Veuillez réessayer.' : 'Sorry, something went wrong. Please try again.';
  }
};

module.exports = router;