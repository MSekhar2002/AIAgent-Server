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
                `https://graph.facebook.com/v22.0/${mediaId}`,
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
              // Pass the binary audio data directly to the speech service
              messageContent = await convertSpeechToText(mediaContent.data);
              
              // Log successful voice transcription
              console.log('Voice message transcribed:', messageContent);
              
              // Inform user their voice message was received and processed
              await sendWhatsAppMessage(phoneNumber, `Voice message received. I understood: "${messageContent}". Processing your request...`);
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
          
          // Update conversation context with user information and message intent
          conversation.context = {
            ...conversation.context,
            userName: user.name,
            userPosition: user.position || 'employee',
            userDepartment: user.department || 'general',
            lastInteraction: new Date().toISOString()
          };
          
          conversation.lastActivity = Date.now();
          await conversation.save();
          
          // Classify message intent using Azure OpenAI
          let response;
          let intent;
          
          try {
            // Import the intent classifier
            const { classifyIntent } = require('../../utils/intentClassifier');
            
            // Classify the message intent
            intent = await classifyIntent(messageContent);
            console.log(`Classified intent: ${intent} for message: "${messageContent}"`);
            
            // Add the intent to the conversation context
            conversation.context.lastIntent = intent;
            await conversation.save(); 
            
            // Process based on intent
            if (intent === 'schedule_query') {
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
            } else if (intent === 'schedule_query' && (
              messageContent.toLowerCase().includes('this week') ||
              messageContent.toLowerCase().includes('upcoming')
            )) {
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
            } else if (intent === 'traffic_query') {
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
            } else if (intent === 'route_query') {
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
            } else if (intent === 'admin_command') {
              // Check if user has admin role
              if (user.role !== 'admin') {
                // Non-admin users attempting admin actions
                response = `Sorry, you don't have permission to perform administrative actions. This requires admin privileges.`;
              } else {
                // Handle admin commands using NLP without requiring /admin prefix
                const command = messageContent.trim();
                response = await handleAdminCommand(command, user, phoneNumber);
              }
            } else if (intent === 'absence_request') {
              // Handle absence requests with NLP
              try {
                // Extract absence details from the message
                const Absence = require('../../models/Absence');
                
                // Create a new absence request
                const absence = new Absence({
                  user: user._id,
                  status: 'pending',
                  requestedVia: 'whatsapp',
                  notes: messageContent
                });
                
                // Try to extract dates from the message using a simple regex
                const dateRegex = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/g;
                const dates = messageContent.match(dateRegex);
                
                // Extract reason from the message using NLP patterns
                let reason = messageContent;
                
                // Look for reason indicators in the message
                const reasonIndicators = [
                  'because', 'due to', 'reason is', 'reason:', 'for', 'as I', 'since'
                ];
                
                // Try to extract a more specific reason if indicators are present
                for (const indicator of reasonIndicators) {
                  if (messageContent.toLowerCase().includes(indicator)) {
                    const parts = messageContent.split(new RegExp(`${indicator}\s+`, 'i'));
                    if (parts.length > 1) {
                      // Take the part after the indicator as the reason
                      reason = parts[1].trim();
                      break;
                    }
                  }
                }
                
                if (dates && dates.length > 0) {
                  // If we found dates, use them for start and end dates
                  absence.startDate = new Date(dates[0]);
                  absence.endDate = dates.length > 1 ? new Date(dates[1]) : new Date(dates[0]);
                  absence.reason = reason;
                } else {
                  // Default to today if no dates found
                  const today = new Date();
                  absence.startDate = today;
                  absence.endDate = today;
                  absence.reason = reason;
                }
                
                // Save the absence request
                await absence.save();
                
                // Notify admin about the new absence request
                const admins = await User.find({ role: 'admin' });
                for (const admin of admins) {
                  if (admin.phone) {
                    await sendWhatsAppMessage(
                      admin.phone,
                      `New absence request from ${user.name} (${user.department || 'N/A'}):\n\n` +
                      `Dates: ${absence.startDate.toLocaleDateString()} to ${absence.endDate.toLocaleDateString()}\n` +
                      `Reason: ${absence.reason || absence.notes}\n\n` +
                      `Reply to this message to approve or deny.`
                    );
                  }
                }
                
                response = `Thank you for your absence request. Your request has been submitted and is pending approval. ` +
                          `You will be notified once it has been processed.`;
              } catch (absenceErr) {
                console.error('Absence request error:', absenceErr.message);
                response = `I'm sorry, I couldn't process your absence request. Please try again with a clearer message ` +
                          `or contact your administrator directly.`;
              }
            } else if (intent === 'general_question') {
              // For general questions, use Azure OpenAI to generate a response
              const conversationHistory = conversation.messages.map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'assistant',
                content: msg.content
              }));
              
              response = await processWithAzureOpenAI(messageContent, conversationHistory, user);
            } else {
              // Fallback for any other intent or if classification fails
              console.log(`Using fallback handler for intent: ${intent}`);
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

// Admin command handler for WhatsApp
async function handleAdminCommand(command, user, phoneNumber) {
  try {
    // Process natural language admin commands
    // Extract command intent using NLP patterns
    const commandLower = command.toLowerCase();
    
    // Determine the admin action based on natural language understanding
    let action = '';
    
    // Help command detection
    if (commandLower.includes('help') || 
        commandLower.includes('commands') || 
        commandLower.includes('what can you do') || 
        commandLower.includes('show commands')) {
      action = 'help';
    }
    // Users command detection
    else if (commandLower.includes('users') || 
             commandLower.includes('show users') || 
             commandLower.includes('list users') || 
             commandLower.includes('all users')) {
      action = 'users';
    }
    // Schedules command detection
    else if (commandLower.includes('schedules') || 
             commandLower.includes('today\'s schedules') || 
             commandLower.includes('show schedules') || 
             commandLower.includes('list schedules')) {
      action = 'schedules';
    }
    // Broadcast command detection
    else if (commandLower.includes('broadcast') || 
             commandLower.includes('message all') || 
             commandLower.includes('send to all') || 
             commandLower.includes('message everyone')) {
      action = 'broadcast';
    }
    // Notify command detection
    else if (commandLower.includes('notify') || 
             commandLower.includes('message user') || 
             commandLower.includes('send to user')) {
      action = 'notify';
    }
    // Status command detection
    else if (commandLower.includes('status') || 
             commandLower.includes('system status') || 
             commandLower.includes('show status')) {
      action = 'status';
    }
    // Absences command detection
    else if (commandLower.includes('absences') || 
             commandLower.includes('absence requests') || 
             commandLower.includes('time off requests') || 
             commandLower.includes('pending absences')) {
      action = 'absences';
    }
    // Approve command detection
    else if (commandLower.includes('approve') || 
             commandLower.includes('accept')) {
      action = 'approve';
    }
    // Reject command detection
    else if (commandLower.includes('reject') || 
             commandLower.includes('deny') || 
             commandLower.includes('decline')) {
      action = 'reject';
    }
    else {
      // Default to help if command not recognized
      return `I couldn't understand your admin command. Try asking for "admin help" to see available commands.`;
    }
    
    // Split command into parts for parameter extraction
    const parts = command.split(' ');
    
    // Handle different admin commands
    switch (action) {
      case 'help':
        return `*Available Admin Commands:*

You can now use natural language for all commands! Here are some examples:

*Help & Information*
- "Show admin commands" or "What can I do as admin?"

*User Management*
- "Show all users" or "List the users in the system"

*Schedules*
- "Show today's schedules" or "What are the schedules for today?"

*Messaging*
- "Broadcast: [your message]" or "Send message to everyone: [your message]"
- "Notify John about [your message]" or "Send message to John: [your message]"

*System Status*
- "Show system status" or "What's the current system status?"

*Absence Management*
- "Show pending absences" or "List absence requests"
- "Approve absence from John" or "Accept John's absence request"
- "Reject absence request from Sarah" or "Deny Sarah's time off"

You can use natural language - the system will understand your intent!`;
      
      case 'users':
        const users = await User.find().select('name email phone role department position');
        let userList = '*User List*\n\n';
        
        users.forEach((u, index) => {
          userList += `${index + 1}. ${u.name} (${u.role})\n`;
          userList += `   ID: ${u._id}\n`;
          userList += `   Dept: ${u.department || 'N/A'}\n`;
          userList += `   Phone: ${u.phone || 'N/A'}\n\n`;
        });
        
        return userList;
      
      case 'schedules':
        // Process natural language date references in the command
        let targetDate = new Date();
        targetDate.setHours(0, 0, 0, 0);
        
        // Check for date references in the command
        if (commandLower.includes('tomorrow')) {
          targetDate.setDate(targetDate.getDate() + 1);
        } else if (commandLower.includes('yesterday')) {
          targetDate.setDate(targetDate.getDate() - 1);
        } else if (commandLower.match(/next (mon|tues|wednes|thurs|fri|satur|sun)day/i)) {
          // Handle next weekday references
          const dayMatch = commandLower.match(/next (mon|tues|wednes|thurs|fri|satur|sun)day/i);
          if (dayMatch) {
            const dayPrefix = dayMatch[1].toLowerCase();
            let targetDay;
            
            switch (dayPrefix) {
              case 'mon': targetDay = 1; break;
              case 'tues': targetDay = 2; break;
              case 'wednes': targetDay = 3; break;
              case 'thurs': targetDay = 4; break;
              case 'fri': targetDay = 5; break;
              case 'satur': targetDay = 6; break;
              case 'sun': targetDay = 0; break;
              default: targetDay = null;
            }
            
            if (targetDay !== null) {
              // Calculate days to add
              const currentDay = targetDate.getDay();
              let daysToAdd = targetDay - currentDay;
              if (daysToAdd <= 0) daysToAdd += 7; // Ensure we're getting next week's day
              
              targetDate.setDate(targetDate.getDate() + daysToAdd);
            }
          }
        } else if (commandLower.includes('next week')) {
          // Set to next Monday
          const currentDay = targetDate.getDay();
          const daysToAdd = currentDay === 1 ? 7 : (8 - currentDay) % 7;
          targetDate.setDate(targetDate.getDate() + daysToAdd);
        }
        
        // Get the next day for date range
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);
        
        // Find schedules for the target date
        const schedules = await Schedule.find({
          date: { $gte: targetDate, $lt: nextDay }
        }).populate('location assignedEmployees', 'name address city');
        
        // Format the date for display
        const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const formattedDate = targetDate.toLocaleDateString(undefined, dateOptions);
        
        if (schedules.length === 0) {
          return `No schedules found for ${formattedDate}.`;
        }
        
        let scheduleList = `*Schedules for ${formattedDate}*\n\n`;
        
        schedules.forEach((schedule, index) => {
          scheduleList += `${index + 1}. ${schedule.title}\n`;
          scheduleList += `   Time: ${schedule.startTime} - ${schedule.endTime}\n`;
          scheduleList += `   Location: ${schedule.location.name}\n`;
          scheduleList += `   Employees: ${schedule.assignedEmployees.map(e => e.name).join(', ')}\n\n`;
        });
        
        return scheduleList;
      
      case 'broadcast':
        // Extract the message from natural language command
        let broadcastMessage = '';
        
        // Find the message content after broadcast indicators
        const broadcastIndicators = ['broadcast', 'message all', 'send to all', 'message everyone', 'tell everyone', 'announce'];
        
        // Find which indicator was used and extract the message after it
        for (const indicator of broadcastIndicators) {
          const index = commandLower.indexOf(indicator);
          if (index !== -1) {
            // Extract message after the indicator plus its length and a space
            const startPos = index + indicator.length + 1;
            if (startPos < command.length) {
              broadcastMessage = command.substring(startPos).trim();
              break;
            }
          }
        }
        
        // Check if there's a message to broadcast
        if (!broadcastMessage) {
          return 'Please provide a message to broadcast. For example: "broadcast Hello everyone" or "send message to all users: Important update"';
        }
        
        // Get all users
        const allUsers = await User.find().select('phone');
        let sentCount = 0;
        
        // Send message to all users with phone numbers
        for (const u of allUsers) {
          if (u.phone) {
            await sendWhatsAppMessage(u.phone, `*BROADCAST MESSAGE FROM ADMIN*\n\n${broadcastMessage}`);
            sentCount++;
          }
        }
        
        return `Broadcast message sent to ${sentCount} users.`;
      
      case 'notify':
        // Extract user identifier and message from natural language command
        let userIdentifier = '';
        let notifyMessage = '';
        
        // Common patterns for notify commands
        // Examples: "notify John about meeting", "send message to +1234567890: Hello", "message user John: reminder"
        
        // Pattern 1: "notify [user] about [message]" or "notify [user] [message]"
        if (commandLower.includes('notify')) {
          const afterNotify = command.substring(commandLower.indexOf('notify') + 'notify'.length).trim();
          // Check if "about" is used as separator
          if (afterNotify.includes(' about ')) {
            const parts = afterNotify.split(' about ');
            userIdentifier = parts[0].trim();
            notifyMessage = parts[1].trim();
          } else {
            // Extract first word as user and rest as message
            const parts = afterNotify.split(' ');
            if (parts.length >= 2) {
              userIdentifier = parts[0].trim();
              notifyMessage = parts.slice(1).join(' ').trim();
            }
          }
        }
        
        // Pattern 2: "send message to [user]: [message]" or "message user [user]: [message]"
        else if (commandLower.includes('message to') || commandLower.includes('message user') || 
                commandLower.includes('send to user')) {
          let afterIndicator = '';
          
          if (commandLower.includes('message to')) {
            afterIndicator = command.substring(commandLower.indexOf('message to') + 'message to'.length).trim();
          } else if (commandLower.includes('message user')) {
            afterIndicator = command.substring(commandLower.indexOf('message user') + 'message user'.length).trim();
          } else if (commandLower.includes('send to user')) {
            afterIndicator = command.substring(commandLower.indexOf('send to user') + 'send to user'.length).trim();
          }
          
          // Check if colon is used as separator
          if (afterIndicator.includes(':')) {
            const parts = afterIndicator.split(':');
            userIdentifier = parts[0].trim();
            notifyMessage = parts[1].trim();
          } else if (afterIndicator.includes(' that ')) {
            // Pattern: "tell John that the meeting is canceled"
            const parts = afterIndicator.split(' that ');
            userIdentifier = parts[0].trim();
            notifyMessage = parts[1].trim();
          } else {
            // Try to extract first word as user and rest as message
            const parts = afterIndicator.split(' ');
            if (parts.length >= 2) {
              userIdentifier = parts[0].trim();
              notifyMessage = parts.slice(1).join(' ').trim();
            }
          }
        }
        
        // Check if we have both user and message
        if (!userIdentifier || !notifyMessage) {
          return 'Please specify both a user and a message. For example: "notify John about the meeting" or "send message to John: Hello"';
        }
        
        // Find the user by ID, phone, or name
        let recipient;
        if (mongoose.Types.ObjectId.isValid(userIdentifier)) {
          recipient = await User.findById(userIdentifier);
        } else {
          // Try to find by phone (with or without +)
          const phoneQuery = userIdentifier.startsWith('+') ? userIdentifier : `+${userIdentifier}`;
          recipient = await User.findOne({ phone: { $regex: phoneQuery, $options: 'i' } });
          
          // If not found by phone, try by name
          if (!recipient) {
            recipient = await User.findOne({ name: { $regex: userIdentifier, $options: 'i' } });
          }
        }
        
        if (!recipient || !recipient.phone) {
          return `Could not find a user with identifier: ${userIdentifier}`;
        }
        
        // Send the message
        try {
          await sendWhatsAppMessage(recipient.phone, `*MESSAGE FROM ADMIN*\n\n${notifyMessage}`);
          return `Message sent to ${recipient.name}.`;
        } catch (err) {
          console.error(`Failed to send notification to ${recipient.phone}:`, err);
          return `Failed to send message to ${recipient.name}. Error: ${err.message}`;
        }
      
      case 'status':
        // Get system status
        const userCount = await User.countDocuments();
        const scheduleCount = await Schedule.countDocuments();
        const locationCount = await Location.countDocuments();
        const activeConversations = await Conversation.countDocuments({ active: true });
        
        return `*System Status*\n\n` +
               `Users: ${userCount}\n` +
               `Schedules: ${scheduleCount}\n` +
               `Locations: ${locationCount}\n` +
               `Active Conversations: ${activeConversations}\n` +
               `Server Time: ${new Date().toLocaleString()}`;
      
      case 'absences':
        // Get pending absence requests
        const Absence = require('../../models/Absence');
        const pendingAbsences = await Absence.find({ status: 'pending' })
          .populate('user', 'name department position')
          .sort({ startDate: 1 });
        
        if (pendingAbsences.length === 0) {
          return 'No pending absence requests found.';
        }
        
        let absenceList = '*Pending Absence Requests*\n\n';
        
        pendingAbsences.forEach((absence, index) => {
          const startDate = new Date(absence.startDate).toLocaleDateString();
          const endDate = new Date(absence.endDate).toLocaleDateString();
          
          absenceList += `${index + 1}. ${absence.user.name} (${absence.user.department})\n`;
          absenceList += `   Period: ${startDate} to ${endDate}\n`;
          absenceList += `   Reason: ${absence.reason}\n`;
          absenceList += `   ID: ${absence._id}\n\n`;
        });
        
        absenceList += 'To approve: /admin approve [absenceId]\n';
        absenceList += 'To reject: /admin reject [absenceId]';
        
        return absenceList;
      
      case 'approve':
        // Extract absence ID from natural language command
        let approveAbsenceId = '';
        
        // Look for patterns like "approve absence [id]" or "accept request [id]"
        const approvePatterns = [
          /approve\s+(?:absence|request)?\s*(?:with\s+id\s*)?([a-f0-9]{24})/i,
          /accept\s+(?:absence|request)?\s*(?:with\s+id\s*)?([a-f0-9]{24})/i,
          /approve\s+(?:the\s+)?(?:absence|request)\s*(?:from|by|for)\s+([\w\s]+)\s+(?:on|for|dated)\s+([\w\s,]+)/i
        ];
        
        // Try to extract absence ID using regex patterns
        for (const pattern of approvePatterns) {
          const match = command.match(pattern);
          if (match && match[1]) {
            // If it's a MongoDB ObjectId format
            if (match[1].match(/^[a-f0-9]{24}$/i)) {
              approveAbsenceId = match[1];
              break;
            }
          }
        }
        
        // If no ID found through regex, try to find the most recent absence request mentioned
        if (!approveAbsenceId) {
          // Look for user name in the command
          const userNameMatch = command.match(/(?:from|by|for)\s+([\w\s]+)(?:\s+on|\s+for|\s+dated|$)/i);
          
          if (userNameMatch && userNameMatch[1]) {
            const userName = userNameMatch[1].trim();
            // Find user by name
            const absenceUser = await User.findOne({ name: { $regex: userName, $options: 'i' } });
            
            if (absenceUser) {
              // Find the most recent pending absence for this user
              const recentAbsence = await Absence.findOne({ 
                user: absenceUser._id,
                status: 'pending'
              }).sort({ createdAt: -1 });
              
              if (recentAbsence) {
                approveAbsenceId = recentAbsence._id.toString();
              }
            }
          } else {
            // If no user specified, look for the most recent pending absence
            const recentAbsence = await Absence.findOne({ status: 'pending' })
              .sort({ createdAt: -1 });
            
            if (recentAbsence) {
              approveAbsenceId = recentAbsence._id.toString();
            }
          }
        }
        
        // Check if we found an absence ID
        if (!approveAbsenceId) {
          return 'I couldn\'t identify which absence request you want to approve. Please specify an absence ID or mention the user\'s name.';
        }
        
        // Find the absence
        const absenceToApprove = await Absence.findById(approveAbsenceId).populate('user', 'name phone');
        if (!absenceToApprove) {
          return `Could not find an absence with ID: ${approveAbsenceId}`;
        }
        
        // Update absence status
        absenceToApprove.status = 'approved';
        absenceToApprove.approvedBy = user._id;
        absenceToApprove.approvedAt = Date.now();
        await absenceToApprove.save();
        
        // Notify user of approval
        if (absenceToApprove.user.phone) {
          await sendWhatsAppMessage(
            absenceToApprove.user.phone,
            `Your absence request from ${new Date(absenceToApprove.startDate).toLocaleDateString()} to ${new Date(absenceToApprove.endDate).toLocaleDateString()} has been approved.`
          );
        }
        
        return `Absence request for ${absenceToApprove.user.name} has been approved.`;
      
      case 'reject':
        // Extract absence ID from natural language command
        let rejectAbsenceId = '';
        
        // Look for patterns like "reject absence [id]" or "deny request [id]"
        const rejectPatterns = [
          /reject\s+(?:absence|request)?\s*(?:with\s+id\s*)?([a-f0-9]{24})/i,
          /deny\s+(?:absence|request)?\s*(?:with\s+id\s*)?([a-f0-9]{24})/i,
          /decline\s+(?:absence|request)?\s*(?:with\s+id\s*)?([a-f0-9]{24})/i,
          /reject\s+(?:the\s+)?(?:absence|request)\s*(?:from|by|for)\s+([\w\s]+)\s+(?:on|for|dated)\s+([\w\s,]+)/i
        ];
        
        // Try to extract absence ID using regex patterns
        for (const pattern of rejectPatterns) {
          const match = command.match(pattern);
          if (match && match[1]) {
            // If it's a MongoDB ObjectId format
            if (match[1].match(/^[a-f0-9]{24}$/i)) {
              rejectAbsenceId = match[1];
              break;
            }
          }
        }
        
        // If no ID found through regex, try to find the most recent absence request mentioned
        if (!rejectAbsenceId) {
          // Look for user name in the command
          const userNameMatch = command.match(/(?:from|by|for)\s+([\w\s]+)(?:\s+on|\s+for|\s+dated|$)/i);
          
          if (userNameMatch && userNameMatch[1]) {
            const userName = userNameMatch[1].trim();
            // Find user by name
            const absenceUser = await User.findOne({ name: { $regex: userName, $options: 'i' } });
            
            if (absenceUser) {
              // Find the most recent pending absence for this user
              const recentAbsence = await Absence.findOne({ 
                user: absenceUser._id,
                status: 'pending'
              }).sort({ createdAt: -1 });
              
              if (recentAbsence) {
                rejectAbsenceId = recentAbsence._id.toString();
              }
            }
          } else {
            // If no user specified, look for the most recent pending absence
            const recentAbsence = await Absence.findOne({ status: 'pending' })
              .sort({ createdAt: -1 });
            
            if (recentAbsence) {
              rejectAbsenceId = recentAbsence._id.toString();
            }
          }
        }
        
        // Check if we found an absence ID
        if (!rejectAbsenceId) {
          return 'I couldn\'t identify which absence request you want to reject. Please specify an absence ID or mention the user\'s name.';
        }
        
        // Find the absence
        const absenceToReject = await Absence.findById(rejectAbsenceId).populate('user', 'name phone');
        
        if (!absenceToReject) {
          return `Could not find an absence with ID: ${rejectAbsenceId}`;
        }
        
        // Update absence status
        absenceToReject.status = 'rejected';
        absenceToReject.rejectedBy = user._id;
        absenceToReject.rejectedAt = Date.now();
        await absenceToReject.save();
        
        // Notify user of rejection
        if (absenceToReject.user.phone) {
          await sendWhatsAppMessage(
            absenceToReject.user.phone,
            `Your absence request from ${new Date(absenceToReject.startDate).toLocaleDateString()} to ${new Date(absenceToReject.endDate).toLocaleDateString()} has been rejected.`
          );
        }
        
        return `Absence request for ${absenceToReject.user.name} has been rejected.`;
      
      default:
        return `Unknown admin command: ${action}\n\nType /admin help for available commands.`;
    }
  } catch (error) {
    console.error('Admin command error:', error.message);
    return `Error executing admin command: ${error.message}`;
  }
}

module.exports = router;