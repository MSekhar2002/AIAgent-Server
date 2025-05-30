const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const axios = require('axios');
const mongoose = require('mongoose');
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
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// @route   POST api/whatsapp/webhook
// @desc    Receive and process WhatsApp messages
// @access  Public
router.post('/webhook', async (req, res) => {
  try {
    res.status(200).send('EVENT_RECEIVED');
    const data = req.body;

    if (data.object !== 'whatsapp_business_account') return;

    for (const entry of data.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        for (const message of change.value.messages || []) {
          const phoneNumber = message.from;
          const user = await User.findOne({ phone: phoneNumber });

          if (!user) {
            await sendWhatsAppMessage(phoneNumber, 'This number is only for registered employees. Please contact your administrator.');
            continue;
          }

          let messageContent = '';
          let isVoiceMessage = false;

          if (message.type === 'text') {
            messageContent = message.text.body;
          } else if (message.type === 'audio') {
            isVoiceMessage = true;
            try {
              const mediaId = message.audio.id;
              const client = createMetaClient();
              const mediaResponse = await axios.get(
                `https://graph.facebook.com/v22.0/${mediaId}`,
                { headers: { 'Authorization': `Bearer ${client.token}` } }
              );
              const mediaUrl = mediaResponse.data.url;
              const mediaContent = await axios.get(mediaUrl, {
                headers: { 'Authorization': `Bearer ${client.token}` },
                responseType: 'arraybuffer'
              });
              messageContent = await convertSpeechToText(mediaContent.data);
              await sendWhatsAppMessage(phoneNumber, `Voice message received: "${messageContent}". Processing...`);
            } catch (speechErr) {
              console.error('Speech-to-text error:', speechErr.message);
              await sendWhatsAppMessage(phoneNumber, 'Couldn’t process voice message. Please send text.');
              continue;
            }
          } else {
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

          let response;
          try {
            // Send user message, user role, and model schemas to Azure OpenAI
            const queryResult = await generateMongoDBQuery(messageContent, user, modelSchemas);

            if (queryResult.error) {
              response = `Error processing your request: ${queryResult.message}`;
            } else if (queryResult.unclear) {
              response = 'Your request is unclear. Please provide more details.';
            } else {
              const { model, operation, query } = queryResult;

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
                  response = `Invalid model: ${model}`;
                  await sendWhatsAppMessage(phoneNumber, response);
                  continue;
              }

              if (operation === 'read') {
                const results = query.pipeline
                  ? await Model.aggregate(query.pipeline).exec()
                  : await Model.find(query.filter).populate(query.populate || []);

                if (results.length === 0) {
                  response = `No ${model} records found.`;
                } else {
                  response = formatResults(model, results);
                }
              } else if (operation === 'write') {
                const result = await Model.create(query.data);
                response = `${model.charAt(0).toUpperCase() + model.slice(1)} created successfully. ID: ${result._id}`;
              } else if (operation === 'update') {
                const result = await Model.findOneAndUpdate(query.filter, query.update, { new: true });
                if (!result) {
                  response = `No ${model} record found to update.`;
                } else {
                  response = `${model.charAt(0).toUpperCase() + model.slice(1)} updated successfully.`;
                }
              } else if (operation === 'delete') {
                const result = await Model.findOneAndDelete(query.filter);
                if (!result) {
                  response = `No ${model} record found to delete.`;
                } else {
                  response = `${model.charAt(0).toUpperCase() + model.slice(1)} deleted successfully.`;
                }
              } else {
                response = 'Unsupported operation.';
              }
            }
          } catch (aiErr) {
            console.error('AI processing error:', aiErr.message);
            response = 'Error processing your request. Please try again.';
          }

          conversation.messages.push({ sender: 'system', content: response });
          conversation.lastActivity = Date.now();
          await conversation.save();

          await sendWhatsAppMessage(phoneNumber, response);
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err.message);
  }
});

// Helper to create Meta client
const createMetaClient = () => {
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    throw new Error('Meta WhatsApp credentials not configured');
  }

  return {
    token,
    phoneNumberId,
    apiUrl: `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`
  };
};

// Helper to format query results
const formatResults = (model, results) => {
  let response = `*${model.charAt(0).toUpperCase() + model.slice(1)} Results (${results.length})*\n\n`;

  results.forEach((item, index) => {
    response += `${index + 1}. `;
    Object.entries(item).forEach(([key, value]) => {
      if (key !== '_id' && key !== '__v' && value) {
        if (value instanceof Date) {
          response += `${key}: ${value.toLocaleString()}\n`;
        } else if (typeof value === 'object' && value.name) {
          response += `${key}: ${value.name}\n`;
        } else if (typeof value !== 'object') {
          response += `${key}: ${value}\n`;
        }
      }
    });
    response += '\n';
  });

  return response;
};

// Admin routes remain unchanged but simplified
router.post('/send', [auth, admin], async (req, res) => {
  const { userId, message } = req.body;
  try {
    const user = await User.findById(userId);
    if (!user || !user.phone) {
      return res.status(404).json({ msg: 'User or phone not found' });
    }
    await sendWhatsAppMessage(user.phone, message);
    res.json({ msg: 'Message sent' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

router.get('/conversations', [auth, admin], async (req, res) => {
  try {
    const conversations = await Conversation.find()
      .populate('user', 'name email phone')
      .sort({ lastActivity: -1 });
    res.json(conversations);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

router.get('/conversations/:id', [auth, admin], async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id)
      .populate('user', 'name email phone');
    if (!conversation) {
      return res.status(404).json({ msg: 'Conversation not found' });
    }
    res.json(conversation);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

router.get('/settings', [auth, admin], async (req, res) => {
  try {
    let settings = await WhatsAppSettings.findOne();
    if (!settings) {
      settings = new WhatsAppSettings();
      await settings.save();
    }
    res.json(settings);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

router.put('/settings', [auth, admin], async (req, res) => {
  try {
    let settings = await WhatsAppSettings.findOne();
    if (!settings) {
      settings = new WhatsAppSettings();
    }
    Object.assign(settings, req.body);
    settings.updatedAt = Date.now();
    await settings.save();
    res.json(settings);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;