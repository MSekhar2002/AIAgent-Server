const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const axios = require('axios');
const User = require('../../models/User');
const Schedule = require('../../models/Schedule');
const Location = require('../../models/Location');
const Conversation = require('../../models/Conversation');
const { sendWhatsAppMessage } = require('../../utils/whatsappService');
const { processWithAzureOpenAI } = require('../../utils/aiService');
const { convertSpeechToText } = require('../../utils/speechService');

// @route   POST api/whatsapp/webhook
// @desc    Receive WhatsApp messages via Meta webhook
// @access  Public
router.get('/webhook', (req, res) => {
  // Handle the verification request from Meta
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  // Verify token should match the one set in your Meta developer portal
  const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN;
  
  if (mode === 'subscribe' && token === verifyToken) {
    // Respond with the challenge to confirm the webhook
    return res.status(200).send(challenge);
  }
  
  // If verification fails
  return res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  try {
    // Immediately respond to the webhook to prevent timeouts
    res.status(200).send('EVENT_RECEIVED');
    
    // Extract message details from Meta webhook
    const data = req.body;
    
    // Check if this is a WhatsApp message
    if (data.object !== 'whatsapp_business_account') {
      return;
    }
    
    // Process each entry in the webhook
    for (const entry of data.entry) {
      // Process each change in the entry
      for (const change of entry.changes) {
        // Check if this is a message
        if (change.field !== 'messages') {
          continue;
        }
        
        // Process each message
        for (const message of change.value.messages || []) {
          // Extract phone number
          const phoneNumber = message.from;
          
          // Find user by phone number
          const user = await User.findOne({ phone: phoneNumber });
          
          if (!user) {
            // If user not found, send a generic response
            const response = `Thank you for your message. This number is only available for registered employees. Please contact your administrator if you believe this is an error.`;
            
            await sendWhatsAppMessage(phoneNumber, response);
            continue;
          }
          
          // Process message content
          let messageContent = '';
          let isVoiceMessage = false;
          
          // Handle different message types
          if (message.type === 'text') {
            messageContent = message.text.body;
          } else if (message.type === 'audio') {
            isVoiceMessage = true;
            
            try {
              // Get media ID
              const mediaId = message.audio.id;
              
              // Get media URL from Meta
              const client = createMetaClient();
              const mediaResponse = await axios.get(
                `https://graph.facebook.com/v17.0/${mediaId}`,
                {
                  headers: {
                    'Authorization': `Bearer ${client.token}`
                  }
                }
              );
              
              const mediaUrl = mediaResponse.data.url;
              
              // Download media
              const mediaContent = await axios.get(mediaUrl, {
                headers: {
                  'Authorization': `Bearer ${client.token}`
                },
                responseType: 'arraybuffer'
              });
              
              // Convert voice message to text using Azure Speech Services
              messageContent = await convertSpeechToText(mediaContent.data);
            } catch (speechErr) {
              console.error('Speech-to-text error:', speechErr.message);
              messageContent = 'Sorry, I couldn\'t understand your voice message. Please try again or send a text message.';
              await sendWhatsAppMessage(phoneNumber, messageContent);
              continue;
            }
          } else {
            // Unsupported message type
            await sendWhatsAppMessage(phoneNumber, 'Sorry, I can only process text and voice messages at this time.');
            continue;
          }
          
          // Find or create conversation for context management
          let conversation = await Conversation.findOne({
            user: user._id,
            active: true
          });
          
          if (!conversation) {
            conversation = new Conversation({
              user: user._id,
              platform: isVoiceMessage ? 'voice' : 'whatsapp',
              messages: [],
              context: {}
            });
          }
          
          // Add user message to conversation
          conversation.messages.push({
            sender: 'user',
            content: messageContent,
            originalAudio: isVoiceMessage ? message.audio.id : undefined
          });
          
          // Update conversation context with user information
          conversation.context = {
            ...conversation.context,
            userName: user.name,
            userPosition: user.position || 'employee',
            userDepartment: user.department || 'general',
            lastInteraction: new Date().toISOString()
          };
          
          conversation.lastActivity = Date.now();
          await conversation.save();
          
          // Process message with Azure OpenAI
          let response;
          
          try {
            // Check for common schedule-related queries
            if (
              messageContent.toLowerCase().includes('where do i work') ||
              messageContent.toLowerCase().includes('my schedule') ||
              messageContent.toLowerCase().includes('when do i work') ||
              messageContent.toLowerCase().includes('my shift')
            ) {
              // Get today's date range
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              
              const tomorrow = new Date(today);
              tomorrow.setDate(tomorrow.getDate() + 1);
              
              // Find schedules for today where user is assigned
              const schedules = await Schedule.find({
                assignedEmployees: user._id,
                date: { $gte: today, $lt: tomorrow }
              }).populate('location', 'name address city state');
              
              if (schedules.length === 0) {
                response = `You don't have any schedules for today, ${user.name}.`;
              } else {
                response = `Hello ${user.name}, here's your schedule for today:\n\n`;
                
                for (const schedule of schedules) {
                  response += `- ${schedule.title}\n`;
                  response += `  Time: ${schedule.startTime} - ${schedule.endTime}\n`;
                  response += `  Location: ${schedule.location.name}, ${schedule.location.address}, ${schedule.location.city}\n\n`;
                }
              }
            } else if (
              messageContent.toLowerCase().includes('this week') ||
              messageContent.toLowerCase().includes('upcoming schedule')
            ) {
              // Get this week's date range
              const today = new Date();
              const day = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
              
              // Calculate start of week (Sunday)
              const startOfWeek = new Date(today);
              startOfWeek.setDate(today.getDate() - day);
              startOfWeek.setHours(0, 0, 0, 0);
              
              // Calculate end of week (Saturday)
              const endOfWeek = new Date(startOfWeek);
              endOfWeek.setDate(startOfWeek.getDate() + 7);
              
              // Find schedules for this week where user is assigned
              const schedules = await Schedule.find({
                assignedEmployees: user._id,
                date: { $gte: startOfWeek, $lt: endOfWeek }
              })
                .populate('location', 'name address city')
                .sort({ date: 1, startTime: 1 });
              
              if (schedules.length === 0) {
                response = `You don't have any schedules for this week, ${user.name}.`;
              } else {
                response = `Hello ${user.name}, here's your schedule for this week:\n\n`;
                
                const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                
                for (const schedule of schedules) {
                  const scheduleDate = new Date(schedule.date);
                  const dayName = days[scheduleDate.getDay()];
                  const dateStr = scheduleDate.toLocaleDateString();
                  
                  response += `- ${dayName}, ${dateStr}\n`;
                  response += `  ${schedule.title}\n`;
                  response += `  Time: ${schedule.startTime} - ${schedule.endTime}\n`;
                  response += `  Location: ${schedule.location.name}, ${schedule.location.city}\n\n`;
                }
              }
            } else if (
              messageContent.toLowerCase().includes('traffic') ||
              messageContent.toLowerCase().includes('travel time') ||
              messageContent.toLowerCase().includes('commute')
            ) {
              // Get today's schedules to check for locations
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              
              const tomorrow = new Date(today);
              tomorrow.setDate(tomorrow.getDate() + 1);
              
              const schedules = await Schedule.find({
                assignedEmployees: user._id,
                date: { $gte: today, $lt: tomorrow }
              }).populate('location');
              
              if (schedules.length === 0) {
                response = `You don't have any schedules for today, so I don't have location information to provide traffic updates.`;
              } else {
                try {
                  // Use the mapsService to get real traffic data
                  const { getTrafficData, getRouteInfo } = require('../../utils/mapsService');
                  const schedule = schedules[0];
                  const location = schedule.location;
                  
                  // Store location in conversation context for future reference
                  conversation.context.currentLocation = location;
                  
                  // Get traffic data for the location
                  const trafficData = await getTrafficData(location.coordinates);
                  
                  // Extract traffic information
                  const trafficLevel = trafficData.flowSegmentData.trafficLevel;
                  const trafficDescription = trafficData.flowSegmentData.trafficLevelDescription || 
                    ['no traffic', 'light traffic', 'moderate traffic', 'heavy traffic', 'severe congestion'][trafficLevel];
                  const currentSpeed = trafficData.flowSegmentData.currentSpeed;
                  const travelTime = trafficData.flowSegmentData.currentTravelTime;
                  
                  // Generate response
                  response = `Traffic update for your commute to ${location.name} (${location.address}, ${location.city}):\n\n`;
                  response += `Current conditions: ${trafficDescription}\n`;
                  response += `Current speed: ${currentSpeed} km/h\n`;
                  response += `Estimated travel time: ${travelTime} minutes\n\n`;
                  
                  // Add route suggestions if traffic is heavy
                  if (trafficLevel >= 3) {
                    response += `Traffic is heavy. Consider alternative routes or leaving earlier.\n`;
                    response += `For detailed route options, ask "What are my route options?"\n`;
                  } else {
                    response += `Traffic conditions are favorable. Recommended route: Take the usual route.`;
                  }
                } catch (trafficErr) {
                  console.error('Traffic data error:', trafficErr.message);
                  
                  // Fallback to basic response if traffic service fails
                  const location = schedules[0].location;
                  response = `Traffic update for your commute to ${location.name} (${location.address}, ${location.city}):\n\n`;
                  response += `I'm having trouble getting real-time traffic data right now.\n`;
                  response += `Please check a traffic app for the most current conditions.`;
                }
              }
            } else if (
              messageContent.toLowerCase().includes('route options') ||
              messageContent.toLowerCase().includes('alternative route') ||
              messageContent.toLowerCase().includes('best way to')
            ) {
              // Handle route options requests
              try {
                // Check if we have location context from previous interactions
                const currentLocation = conversation.context.currentLocation;
                
                if (!currentLocation) {
                  // If no location context, check today's schedule
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  
                  const tomorrow = new Date(today);
                  tomorrow.setDate(tomorrow.getDate() + 1);
                  
                  const schedules = await Schedule.find({
                    assignedEmployees: user._id,
                    date: { $gte: today, $lt: tomorrow }
                  }).populate('location');
                  
                  if (schedules.length === 0) {
                    response = `I don't have your destination information. Please ask about your schedule first or specify where you're going.`;
                  } else {
                    const location = schedules[0].location;
                    
                    // Use mapsService to get route options
                    const { getRouteInfo } = require('../../utils/mapsService');
                    
                    // Use a default origin for demo purposes
                    // In a real app, you might ask the user for their current location
                    const defaultOrigin = {
                      latitude: location.coordinates.latitude - 0.05,
                      longitude: location.coordinates.longitude - 0.05
                    };
                    
                    const routeData = await getRouteInfo(defaultOrigin, location.coordinates);
                    
                    response = `Route options to ${location.name} (${location.address}):\n\n`;
                    
                    // Format route options
                    routeData.routes.forEach((route, index) => {
                      const travelTimeMinutes = Math.round(route.summary.travelTimeInSeconds / 60);
                      const distanceKm = Math.round(route.summary.lengthInMeters / 100) / 10;
                      const trafficDelay = Math.round(route.summary.trafficDelayInSeconds / 60);
                      
                      response += `Option ${index + 1}:\n`;
                      response += `Distance: ${distanceKm} km\n`;
                      response += `Travel time: ${travelTimeMinutes} minutes`;
                      
                      if (trafficDelay > 0) {
                        response += ` (includes ${trafficDelay} min delay due to traffic)`;
                      }
                      
                      response += `\n\n`;
                    });
                    
                    // Store route data in conversation context
                    conversation.context.routeData = routeData;
                  }
                } else {
                  // Use location from context
                  const location = currentLocation;
                  
                  // Use mapsService to get route options
                  const { getRouteInfo } = require('../../utils/mapsService');
                  
                  // Use a default origin for demo purposes
                  const defaultOrigin = {
                    latitude: location.coordinates.latitude - 0.05,
                    longitude: location.coordinates.longitude - 0.05
                  };
                  
                  const routeData = await getRouteInfo(defaultOrigin, location.coordinates);
                  
                  response = `Route options to ${location.name} (${location.address}):\n\n`;
                  
                  // Format route options
                  routeData.routes.forEach((route, index) => {
                    const travelTimeMinutes = Math.round(route.summary.travelTimeInSeconds / 60);
                    const distanceKm = Math.round(route.summary.lengthInMeters / 100) / 10;
                    const trafficDelay = Math.round(route.summary.trafficDelayInSeconds / 60);
                    
                    response += `Option ${index + 1}:\n`;
                    response += `Distance: ${distanceKm} km\n`;
                    response += `Travel time: ${travelTimeMinutes} minutes`;
                    
                    if (trafficDelay > 0) {
                      response += ` (includes ${trafficDelay} min delay due to traffic)`;
                    }
                    
                    response += `\n\n`;
                  });
                  
                  // Store route data in conversation context
                  conversation.context.routeData = routeData;
                }
              } catch (routeErr) {
                console.error('Route options error:', routeErr.message);
                response = `I'm having trouble getting route options right now. Please try again later.`;
              }
            } else {
              // For other queries, use Azure OpenAI to generate a response
              const conversationHistory = conversation.messages.map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'assistant',
                content: msg.content
              }));
              
              response = await processWithAzureOpenAI(messageContent, conversationHistory, user);
            }
          } catch (aiErr) {
            console.error('AI processing error:', aiErr.message);
            response = `I'm sorry, I'm having trouble processing your request right now. Please try again later.`;
          }
          
          // Add system response to conversation
          conversation.messages.push({
            sender: 'system',
            content: response
          });
          
          conversation.lastActivity = Date.now();
          await conversation.save();
          
          // Send response back to user
          await sendWhatsAppMessage(phoneNumber, response);
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err.message);
  }
});

// Helper function to create Meta client
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

// @route   POST api/whatsapp/send
// @desc    Send WhatsApp message to a user
// @access  Private/Admin
router.post('/send', [auth, admin], async (req, res) => {
  const { userId, message } = req.body;
  
  try {
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    if (!user.phone) {
      return res.status(400).json({ msg: 'User does not have a phone number' });
    }
    
    // Send WhatsApp message
    await sendWhatsAppMessage(user.phone, message);
    
    res.json({ msg: 'Message sent successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/whatsapp/conversations
// @desc    Get all WhatsApp conversations
// @access  Private/Admin
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

// @route   GET api/whatsapp/conversations/:id
// @desc    Get conversation by ID
// @access  Private/Admin
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
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Conversation not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   GET api/whatsapp/settings
// @desc    Get WhatsApp settings
// @access  Private/Admin
router.get('/settings', [auth, admin], async (req, res) => {
  try {
    // Find WhatsApp settings or create default if not exists
    const WhatsAppSettings = require('../../models/WhatsAppSettings');
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

// @route   PUT api/whatsapp/settings
// @desc    Update WhatsApp settings
// @access  Private/Admin
router.put('/settings', [auth, admin], async (req, res) => {
  try {
    const WhatsAppSettings = require('../../models/WhatsAppSettings');
    let settings = await WhatsAppSettings.findOne();
    
    if (!settings) {
      settings = new WhatsAppSettings();
    }
    
    // Update settings with request body
    const updateFields = [
      'enabled',
      'autoReplyEnabled',
      'welcomeMessage',
      'aiProcessingEnabled',
      'maxResponseLength',
      'aiSystemInstructions',
      'templates',
      'notificationTemplates'
    ];
    
    updateFields.forEach(field => {
      if (req.body[field] !== undefined) {
        settings[field] = req.body[field];
      }
    });
    
    settings.updatedAt = Date.now();
    await settings.save();
    
    res.json(settings);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;