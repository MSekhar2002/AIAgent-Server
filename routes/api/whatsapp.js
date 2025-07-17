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
const { sendWhatsAppMessage, sendWhatsAppTemplate, sendAnnouncementWhatsApp } = require('../../utils/twilioService');
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
// @desc    Receive and process WhatsApp messages from Twilio
// @access  Public
router.post('/webhook', async (req, res) => {
  try {
    logger.debug('Received Twilio webhook POST', { body: req.body });
    
    // Respond to Twilio with TwiML response
    res.status(200).type('text/xml').send('<Response></Response>');
    
    // Extract message data from Twilio request
    const messageFrom = req.body.From;
    const messageBody = req.body.Body;
    const messageType = req.body.MediaContentType0 ? 'media' : 'text';
    const mediaUrl = req.body.MediaUrl0;
    const messageSid = req.body.MessageSid;
    
    if (!messageFrom) {
      logger.warn('Invalid Twilio webhook data - missing From', { messageFrom });
      return;
    }
    
    // Extract phone number from Twilio format (whatsapp:+1234567890)
    const phoneNumber = messageFrom.replace('whatsapp:+', '');
    logger.info('Processing Twilio message', { phoneNumber, messageSid });

    const user = await User.findOne({ phone: phoneNumber });
    if (!user) {
      logger.warn('User not found', { phoneNumber });
      await sendWhatsAppMessage(phoneNumber, 'This number is only for registered employees. Please contact your administrator.');
      return;
    }

    let messageContent = messageBody || '';
    let isVoiceMessage = false;

    // Handle media messages (including voice messages)
    if (messageType === 'media' && mediaUrl) {
      if (req.body.MediaContentType0 && req.body.MediaContentType0.startsWith('audio/')) {
        isVoiceMessage = true;
        try {
          logger.debug('Processing voice message from Twilio', { mediaUrl });
          
          // Download the audio file from Twilio
          const mediaResponse = await axios.get(mediaUrl, { 
            responseType: 'arraybuffer',
            timeout: 15000,
            auth: {
              username: process.env.TWILIO_ACCOUNT_SID,  // Your Account SID
              password: process.env.TWILIO_AUTH_TOKEN    // Your Auth Token
            }          

          });
          
          if (!mediaResponse.data || mediaResponse.data.length === 0) {
            logger.error('Downloaded media content is empty');
            throw new Error('Empty audio buffer');
          }
          
          // Convert speech to text
          messageContent = await convertSpeechToText(mediaResponse.data);
          logger.info('Voice message transcribed', { transcription: messageContent });
          await sendWhatsAppMessage(phoneNumber, `Voice message received: "${messageContent}". Processing...`);
        } catch (speechErr) {
          logger.error('Speech-to-text processing error', { error: speechErr.message });
          await sendWhatsAppMessage(phoneNumber, 'Couldn\'t process voice message. Please send text or try again later.');
          return;
        }
      } else {
        logger.warn('Unsupported media type', { type: req.body.MediaContentType0 });
        await sendWhatsAppMessage(phoneNumber, 'Only text and voice messages are supported.');
        return;
      }
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
      originalAudio: isVoiceMessage ? messageSid : undefined
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
        response = await processWithAzureOpenAI(
          `Greet ${user.name} and explain what the Employee Scheduling System can do for a ${user.role}.`,
          conversation.messages.slice(-5),
          user
        );
        logger.info('Sending welcome message', { userId: user._id });
      } else {
        // Generate MongoDB query
        const queryResult = await generateMongoDBQuery(messageContent, user, modelSchemas, conversation.messages.slice(-5));
        logger.debug('Query result from Azure OpenAI', { queryResult });

        if (queryResult.error) {
          response = await processWithAzureOpenAI(
            `Tell ${user.name} that their request couldn't be processed due to a query issue and suggest trying again or contacting an admin.`,
            conversation.messages.slice(-5),
            user
          );
          logger.error('Query generation error', { error: queryResult.message });
        } else if (queryResult.unclear && queryResult.help && queryResult.context) {
          response = await generateHelpMessageForContext(user, queryResult.context, conversation.messages.slice(-5));
          logger.info('Providing help message for context', { messageContent, context: queryResult.context });
        } else if (queryResult.unclear && queryResult.help) {
          response = await processWithAzureOpenAI(
            `Tell ${user.name} that their request is unclear, suggest clarifying with examples like "list my schedules" or "show user details", and offer a list of options if they ask "What can you do?"`,
            conversation.messages.slice(-5),
            user
          );
          logger.info('Providing help message for unclear query', { messageContent });
        } else if (queryResult.unclear) {
          response = await processWithAzureOpenAI(
            `Tell ${user.name} that their request is unclear and ask for clarification with examples like "list my schedules" or "show user details".`,
            conversation.messages.slice(-5),
            user
          );
          logger.warn('Unclear query', { messageContent });
        } else if (queryResult.intent === 'send_announcement' && user.role === 'admin') {
          const settings = await WhatsAppSettings.findOne();
        
          if (!settings || !settings.enabled || !settings.templates?.general_announcement_update) {
            response = `${user.name}, WhatsApp integration or generalAnnouncement template is not configured.`;
            logger.warn('WhatsApp integration disabled or template missing');
          } else {
            const template = settings.templates.general_announcement_update ;
            const announcementText = queryResult.parameters?.message || 'No message provided';
        
            if (queryResult.parameters?.toAll) {
              const users = await User.find({ phone: { $ne: null }, 'notificationPreferences.whatsapp': true });
              let sentCount = 0;
        
              for (const notifyUser of users) {
                // Detect language using AI
                const aiResponse = await processWithAzureOpenAI(
                  `Detect the language of this message and respond with just "English" or "French": "${announcementText}"`,
                  [],
                  notifyUser
                );
                await sendAnnouncementWhatsApp(notifyUser, announcementText, true, aiResponse);
                sentCount++;
              }
        
              response = `${user.name}, announcement sent to ${sentCount} user(s)!`;
        
            } else if (queryResult.parameters?.targetUser) {
              const targetUser = await User.findOne({ 
                name: new RegExp(`^${queryResult.parameters.targetUser}$`, 'i'),
                phone: { $ne: null },
                'notificationPreferences.whatsapp': true 
              });
        
              if (!targetUser) {
                response = `${user.name}, I couldn't find a user named "${queryResult.parameters.targetUser}" with WhatsApp notifications enabled.`;
                logger.warn('User not found or WhatsApp disabled', { userName: queryResult.parameters.targetUser });
              } else {
                const aiResponse = await processWithAzureOpenAI(
                  `Detect the language of this message and respond with just "English" or "French": "${announcementText}"`,
                  [],
                  targetUser
                );
                await sendAnnouncementWhatsApp(targetUser, announcementText, true, aiResponse); // Set isOutsideSession to true
                response = `${user.name}, announcement sent to ${targetUser.name}!`;
              }
            } else {
              response = `${user.name}, please clarify the recipient (e.g., a user name or "all").`;
            }
          }
        }
         else {
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
              response = await processWithAzureOpenAI(
                `Tell ${user.name} that the model ${model} is invalid and suggest checking their request.`,
                conversation.messages.slice(-5),
                user
              );
              logger.error('Invalid model', { model });
              await sendWhatsAppMessage(phoneNumber, response);
              return;
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
              response = await processWithAzureOpenAI(
                `Tell ${user.name} that no ${model} records were found and ask if they want to try a different query.`,
                conversation.messages.slice(-5),
                user
              );
            } else {
              const formattedResults = formatResults(model, results);
              response = await processWithAzureOpenAI(
                `Share these ${model} results with ${user.name} in a friendly, natural way and ask if they need anything else: ${formattedResults}`,
                conversation.messages.slice(-5),
                user
              );
            }
          } else if (operation === 'write') {
            if (user.role !== 'admin' && !['absence'].includes(model)) {
              response = await processWithAzureOpenAI(
                `Tell ${user.name} that only admins can create ${model} records, and suggest contacting an admin.`,
                conversation.messages.slice(-5),
                user
              );
            } else {
              const result = await Model.create(query.data);
              response = await processWithAzureOpenAI(
                `Tell ${user.name} that a ${model} was created successfully with ID ${result._id} and ask if they need anything else.`,
                conversation.messages.slice(-5),
                user
              );
              logger.info('Write operation successful', { model, id: result._id });
            }
          } else if (operation === 'update') {
            if (user.role !== 'admin' && !['absence'].includes(model)) {
              response = await processWithAzureOpenAI(
                `Tell ${user.name} that only admins can update ${model} records, and suggest contacting an admin.`,
                conversation.messages.slice(-5),
                user
              );
            } else {
              const result = await Model.findOneAndUpdate(query.filter, query.update, { new: true });
              if (!result) {
                response = await processWithAzureOpenAI(
                  `Tell ${user.name} that no ${model} record was found to update and ask if they want to try again.`,
                  conversation.messages.slice(-5),
                  user
                );
              } else {
                if (model === 'absence') {
                  const targetUser = await User.findById(result.user);
                  const status = query.update.$set.status || 'updated';
                  response = await processWithAzureOpenAI(
                    `Tell ${user.name} that ${targetUser.name}'s absence request for ${result.startDate.toLocaleDateString()} was ${status} successfully and ask if they need anything else.`,
                    conversation.messages.slice(-5),
                    user
                  );
                } else {
                  response = await processWithAzureOpenAI(
                    `Tell ${user.name} that the ${model} was updated successfully and ask if they need anything else.`,
                    conversation.messages.slice(-5),
                    user
                  );
                }
                logger.info('Update operation successful', { model });
              }
            }
          } else if (operation === 'delete') {
            if (user.role !== 'admin') {
              response = await processWithAzureOpenAI(
                `Tell ${user.name} that only admins can delete ${model} records, and suggest contacting an admin.`,
                conversation.messages.slice(-5),
                user
              );
            } else {
              const result = await Model.findOneAndDelete(query.filter);
              if (!result) {
                response = await processWithAzureOpenAI(
                  `Tell ${user.name} that no ${model} record was found to delete and ask if they want to try again.`,
                  conversation.messages.slice(-5),
                  user
                );
              } else {
                response = await processWithAzureOpenAI(
                  `Tell ${user.name} that the ${model} was deleted successfully and ask if they need anything else.`,
                  conversation.messages.slice(-5),
                  user
                );
                logger.info('Delete operation successful', { model });
              }
            }
          } else {
            response = await processWithAzureOpenAI(
              `Tell ${user.name} that the operation isn't supported and suggest trying something like "list schedules" or "create absence".`,
              conversation.messages.slice(-5),
              user
            );
            logger.error('Unsupported operation', { operation });
          }
        }
      }
    } catch (aiErr) {
      logger.error('AI processing error', { error: aiErr.message, stack: aiErr.stack });
      response = await processWithAzureOpenAI(
        `Tell ${user.name} that their request couldn't be processed due to an internal error and suggest trying again or contacting an admin.`,
        conversation.messages.slice(-5),
        user
      );
    }

    conversation.messages.push({ sender: 'system', content: response });
    conversation.lastActivity = Date.now();
    await conversation.save();
    logger.debug('Conversation updated with response', { conversationId: conversation._id });

    await sendWhatsAppMessage(phoneNumber, response);
    logger.info('Response sent via Twilio', { phoneNumber, response });
    
  } catch (err) {
    logger.error('Twilio webhook processing error', { error: err.message, stack: err.stack });
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
      .populate('user', 'name email phone')
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
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
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

module.exports = router;
