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
const { sendWhatsAppMessage } = require('../../utils/whatsappService');
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
    new winston.transports.Console()
  ]
});

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
    logger.debug('Received webhook POST', { body: req.body });
    res.status(200).send('EVENT_RECEIVED');
    const data = req.body;

    if (data.object !== 'whatsapp_business_account') {
      logger.warn('Invalid webhook object', { object: data.object });
      return;
    }

    for (const entry of data.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        for (const message of change.value.messages || []) {
          const phoneNumber = message.from;
          logger.info('Processing message', { phoneNumber, messageId: message.id });

          const user = await User.findOne({ phone: phoneNumber });
          if (!user) {
            logger.warn('User not found', { phoneNumber });
            await sendWhatsAppMessage(phoneNumber, 'This number is only for registered employees. Please contact your administrator.');
            continue;
          }

          let messageContent = '';
          let isVoiceMessage = false;

          if (message.type === 'text') {
            messageContent = message.text.body;
            logger.debug('Text message received', { content: messageContent });
          } else if (message.type === 'audio') {
            isVoiceMessage = true;
            try {
              const mediaId = message.audio.id;
              logger.debug('Fetching voice message', { mediaId });

              const client = createMetaClient();
              const mediaResponse = await retry(
                async () => {
                  return await axios.get(
                    `https://graph.facebook.com/v22.0/${mediaId}`,
                    { headers: { 'Authorization': `Bearer ${client.token}` } }
                  );
                },
                {
                  retries: 3,
                  factor: 2,
                  minTimeout: 1000,
                  onRetry: (err, attempt) => {
                    logger.warn('Retrying media metadata fetch', { attempt, error: err.message });
                  }
                }
              );

              const mediaUrl = mediaResponse.data.url;
              logger.debug('Fetching media content', { mediaUrl });

              const mediaContent = await retry(
                async () => {
                  return await axios.get(mediaUrl, {
                    headers: { 'Authorization': `Bearer ${client.token}` },
                    responseType: 'arraybuffer',
                    timeout: 15000
                  });
                },
                {
                  retries: 3,
                  factor: 2,
                  minTimeout: 1000,
                  onRetry: (err, attempt) => {
                    logger.warn('Retrying media content fetch', { attempt, error: err.message });
                  }
                }
              );

              messageContent = await convertSpeechToText(mediaContent.data);
              logger.info('Voice message transcribed', { transcription: messageContent });
              await sendWhatsAppMessage(phoneNumber, `Voice message received: "${messageContent}". Processing...`);
            } catch (speechErr) {
              logger.error('Speech-to-text processing error', { error: speechErr.message });
              await sendWhatsAppMessage(phoneNumber, 'Couldn’t process voice message. Please send text or try again later.');
              continue;
            }
          } else {
            logger.warn('Unsupported message type', { type: message.type });
            await sendWhatsAppMessage(phoneNumber, 'Only text and voice messages are supported.');
            continue;
          }

          let conversation = await Conversation.findOne({ user: user._id, active: true });
          if (!conversation) {
            conversation = new Conversation({
              user: user._id,
              platform: isVoiceMessage ? 'voice' : 'whatsapp',
              messages: [],
              context: {}
            });
            logger.info('Created new conversation', { userId: user._id });
          }

          conversation.messages.push({
            sender: 'user',
            content: messageContent,
            originalAudio: isVoiceMessage ? message.audio.id : undefined
          });

          conversation.context = {
            ...conversation.context,
            userName: user.name,
            userPosition: user.position || 'employee',
            userDepartment: user.department || 'general',
            lastInteraction: new Date().toISOString(),
            userRole: user.role
          };

          conversation.lastActivity = Date.now();
          await conversation.save();
          logger.debug('Conversation updated', { conversationId: conversation._id });

          let response;
          try {
            // Check for greeting messages
            const greetings = ['hi', 'hello', 'hey', 'good morning', 'good evening'];
            const isGreeting = greetings.some(g => messageContent.toLowerCase().startsWith(g));
            if (isGreeting) {
              response = generateWelcomeMessage(user);
              logger.info('Sending welcome message', { userId: user._id });
            } else {
              // Generate MongoDB query with Azure OpenAI
              const queryResult = await generateMongoDBQuery(messageContent, user, modelSchemas, conversation.messages.slice(-5));
              logger.debug('Query result from Azure OpenAI', { queryResult });

              if (queryResult.error) {
                response = `Sorry, ${user.name}, I couldn’t process your request due to a query issue. Please try again or contact your admin.`;
                logger.error('Query generation error', { error: queryResult.message });
              } else if (queryResult.unclear) {
                response = `I’m not sure what you mean, ${user.name}. Could you clarify? For example, try "list my schedules" or "show user details".`;
                logger.warn('Unclear query', { messageContent });
              } else {
                const { model, operation, query } = queryResult;
                logger.info('Executing query', { model, operation, query });

                let Model;
                switch (model) {
                  case 'user': Model = User; break;
                  case 'schedule': Model = Schedule; break;
                  case 'location': Model = Location; break;
                  case 'conversation': Model = Conversation; break;
                  case 'absence': Model = Absence; break;
                  case 'hourTracking': Model = HourTracking; break;
                  case 'whatsappSettings': Model = WhatsAppSettings; break;
                  default:
                    response = `Invalid model: ${model}, ${user.name}. Please check your request.`;
                    logger.error('Invalid model', { model });
                    await sendWhatsAppMessage(phoneNumber, response);
                    continue;
                }

                if (operation === 'read') {
                  let results;
                  if (query.pipeline && query.pipeline.length > 0) {
                    results = await Model.aggregate(query.pipeline).exec();
                  } else {
                    results = await Model.find(query.filter || {}).populate(query.populate || []);
                  }
                  logger.debug('Query results', { count: results.length });

                  if (results.length === 0) {
                    response = `No ${model} records found, ${user.name}. Want to try a different query?`;
                  } else {
                    response = formatResults(model, results, user);
                  }
                } else if (operation === 'write') {
                  const result = await Model.create(query.data);
                  response = `${model.charAt(0).toUpperCase() + model.slice(1)} created successfully, ${user.name}. ID: ${result._id}`;
                  logger.info('Write operation successful', { model, id: result._id });
                } else if (operation === 'update') {
                  const result = await Model.findOneAndUpdate(query.filter, query.update, { new: true });
                  if (!result) {
                    response = `No ${model} record found to update, ${user.name}.`;
                  } else {
                    response = `${model.charAt(0).toUpperCase() + model.slice(1)} updated successfully, ${user.name}.`;
                    logger.info('Update operation successful', { model });
                  }
                } else if (operation === 'delete') {
                  const result = await Model.findOneAndDelete(query.filter);
                  if (!result) {
                    response = `No ${model} record found to delete, ${user.name}.`;
                  } else {
                    response = `${model.charAt(0).toUpperCase() + model.slice(1)} deleted successfully, ${user.name}.`;
                    logger.info('Delete operation successful', { model });
                  }
                } else {
                  response = `Sorry, ${user.name}, that operation isn’t supported. Try something like "list schedules" or "create absence".`;
                  logger.error('Unsupported operation', { operation });
                }
              }
            }
          } catch (aiErr) {
            logger.error('AI processing error', { error: aiErr.message, stack: aiErr.stack });
            response = `Sorry, ${user.name}, I couldn’t process your request due to an internal error. Please try again or contact your admin.`;
          }

          conversation.messages.push({ sender: 'system', content: response });
          conversation.lastActivity = Date.now();
          await conversation.save();
          logger.debug('Conversation updated with response', { conversationId: conversation._id });

          await sendWhatsAppMessage(phoneNumber, response);
          logger.info('Response sent', { phoneNumber, response });
        }
      }
    }
  } catch (err) {
    logger.error('Webhook processing error', { error: err.message, stack: err.stack });
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
    apiUrl: `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`
  };
};

// Helper to generate welcome message based on role
const generateWelcomeMessage = (user) => {
  const baseMessage = `Hello ${user.name}! I’m your scheduling assistant. `;
  const employeeActions = 'You can check your schedules, request absences, view your hours, or get location details. Just ask something like "show my schedule" or "list locations".';
  const adminActions = 'As an admin, you can manage users, schedules, locations, absences, and more. Try "list all users", "create schedule", or "approve absence".';

  if (user.role === 'admin') {
    return `${baseMessage}${adminActions}`;
  }
  return `${baseMessage}${employeeActions}`;
};

// Helper to format query results
const formatResults = (model, results, user) => {
  let response = `**${model.charAt(0).toUpperCase() + model.slice(1)} Results (${results.length})**\n\n`;

  results.forEach((item, index) => {
    response += `${index + 1}. `;
    const cleanItem = item.toObject ? item.toObject() : item; // Remove Mongoose _doc
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

  response += `Anything else you’d like to know, ${user.name}?`;
  logger.debug('Formatted results', { model, count: results.length });
  return response;
};

// Admin routes (unchanged)
router.post('/send', [auth, admin], async (req, res) => {
  const { userId, message } = req.body;
  logger.debug('Admin send message request', { userId, message });
  try {
    const user = await User.findById(userId);
    if (!user || !user.phone) {
      logger.warn('User or phone not found', { userId });
      return res.status(404).json({ msg: 'User or phone not found' });
    }
    await sendWhatsAppMessage(user.phone, message);
    logger.info('Admin message sent', { userId });
    res.json({ msg: 'Message sent' });
  } catch (err) {
    logger.error('Admin send error', { error: err.message });
    res.status(500).send('Server Error');
  }
});

router.get('/conversations', [auth, admin], async (req, res) => {
  logger.debug('Fetching conversations');
  try {
    const conversations = await Conversation.find()
      .populate('user', 'name email phone')
      .sort({ lastActivity: -1 });
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
    const conversation = await Conversation.findById(req.query.id);
    if (!conversation) {
      logger.warn('Conversation not found', { id: req.params.id });
      return res.status(404).json({ msg: 'Conversation not found' });
    }
    logger.info('Conversation retrieved', { id: req.query.id });
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

router.put('/settings', [auth, admin], async (req, res) => {
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

module.exports = router;