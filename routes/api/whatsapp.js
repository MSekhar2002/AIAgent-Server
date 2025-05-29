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
            // Import the intent classifier and AI service
            const { classifyIntent, classifyMultipleIntents } = require('../../utils/intentClassifier');
            const { generateQueryParameters } = require('../../utils/aiService');
            
            // Classify the message intent
            intent = await classifyIntent(messageContent);
            console.log(`Classified intent: ${intent} for message: "${messageContent}"`);
            
            // Check for multiple intents
            const multipleIntents = await classifyMultipleIntents(messageContent);
            console.log(`Multiple intents detected: ${multipleIntents.join(', ')}`);
            
            // Generate query parameters based on the message and intent
            const queryParams = await generateQueryParameters(messageContent, intent, user);
            console.log(`Generated query parameters:`, queryParams);
            
            // Add the intent and query parameters to the conversation context
            conversation.context.lastIntent = intent;
            conversation.context.multipleIntents = multipleIntents;
            conversation.context.queryParams = queryParams;
            await conversation.save(); 
            
            // Process based on intent
            if (intent === 'schedule_query') {
              // Use query parameters from AI to determine date range
              const queryParams = conversation.context.queryParams || {};
              
              // Check if user is requesting all schedules
              const requestingAllSchedules = (
                messageContent.toLowerCase().includes('all schedules') ||
                messageContent.toLowerCase().includes('all the schedules') ||
                messageContent.toLowerCase().includes('every schedule') ||
                messageContent.toLowerCase().includes('irrespective of date') ||
                messageContent.toLowerCase().includes('regardless of date') ||
                (messageContent.toLowerCase().includes('all') && 
                 !messageContent.toLowerCase().includes('today') && 
                 !messageContent.toLowerCase().includes('tomorrow') && 
                 !messageContent.toLowerCase().includes('yesterday') && 
                 !messageContent.toLowerCase().includes('next'))
              );
              
              // Build query based on extracted parameters
              const query = {
                assignedEmployees: user._id,
                status: { $ne: 'cancelled' }
              };
              
              // Handle date filtering based on query parameters
              if (queryParams.date) {
                const dateParam = queryParams.date.toLowerCase();
                
                if (dateParam === 'today') {
                  // Today's date range
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  
                  const tomorrow = new Date(today);
                  tomorrow.setDate(tomorrow.getDate() + 1);
                  
                  query.date = { $gte: today, $lt: tomorrow };
                } else if (dateParam === 'tomorrow') {
                  // Tomorrow's date range
                  const tomorrow = new Date();
                  tomorrow.setDate(tomorrow.getDate() + 1);
                  tomorrow.setHours(0, 0, 0, 0);
                  
                  const dayAfterTomorrow = new Date(tomorrow);
                  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);
                  
                  query.date = { $gte: tomorrow, $lt: dayAfterTomorrow };
                } else if (dateParam === 'this week') {
                  // This week's date range
                  const today = new Date();
                  const day = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
                  
                  // Calculate start of week (Sunday)
                  const startOfWeek = new Date(today);
                  startOfWeek.setDate(today.getDate() - day);
                  startOfWeek.setHours(0, 0, 0, 0);
                  
                  // Calculate end of week (Saturday)
                  const endOfWeek = new Date(startOfWeek);
                  endOfWeek.setDate(startOfWeek.getDate() + 7);
                  
                  query.date = { $gte: startOfWeek, $lt: endOfWeek };
                } else if (dateParam === 'next week') {
                  // Next week's date range
                  const today = new Date();
                  const day = today.getDay();
                  
                  // Calculate start of next week (next Sunday)
                  const startOfNextWeek = new Date(today);
                  startOfNextWeek.setDate(today.getDate() + (7 - day));
                  startOfNextWeek.setHours(0, 0, 0, 0);
                  
                  // Calculate end of next week (next Saturday)
                  const endOfNextWeek = new Date(startOfNextWeek);
                  endOfNextWeek.setDate(startOfNextWeek.getDate() + 7);
                  
                  query.date = { $gte: startOfNextWeek, $lt: endOfNextWeek };
                } else {
                  // Try to parse as a specific date
                  try {
                    const specificDate = new Date(dateParam);
                    if (!isNaN(specificDate.getTime())) {
                      // Valid date
                      specificDate.setHours(0, 0, 0, 0);
                      
                      const nextDay = new Date(specificDate);
                      nextDay.setDate(specificDate.getDate() + 1);
                      
                      query.date = { $gte: specificDate, $lt: nextDay };
                    }
                  } catch (e) {
                    // Invalid date format, use default (today)
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    
                    const tomorrow = new Date(today);
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    
                    query.date = { $gte: today, $lt: tomorrow };
                  }
                }
              } else if (requestingAllSchedules) {
                // No date filtering for 'all schedules'
              } else {
                // Default to today if no date specified
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                
                query.date = { $gte: today, $lt: tomorrow };
              }
              
              // Add schedule_id if specified
              if (queryParams.schedule_id) {
                query._id = queryParams.schedule_id;
              }
              
              // Fetch schedules based on the constructed query
              const schedules = await Schedule.find(query)
                .populate('location', 'name address city state')
                .sort({ date: 1, startTime: 1 });
              
              if (schedules.length === 0) {
                // Determine appropriate response based on query
                if (query.date) {
                  const dateDescription = queryParams.date || 'the specified date';
                  response = `You don't have any schedules for ${dateDescription}, ${user.name}.`;
                } else {
                  response = `You don't have any schedules assigned to you, ${user.name}.`;
                }
              } else {
                // Format response based on query
                if (requestingAllSchedules || !query.date) {
                  response = `Hello ${user.name}, here are all your schedules (${schedules.length} total):\n\n`;
                  
                  // Group schedules by date for better readability
                  const schedulesByDate = {};
                  
                  schedules.forEach(schedule => {
                    const scheduleDate = new Date(schedule.date);
                    const dateStr = scheduleDate.toLocaleDateString(undefined, { 
                      weekday: 'long', 
                      month: 'long', 
                      day: 'numeric' 
                    });
                    
                    if (!schedulesByDate[dateStr]) {
                      schedulesByDate[dateStr] = [];
                    }
                    
                    schedulesByDate[dateStr].push(schedule);
                  });
                  
                  // Format output by date groups
                  Object.keys(schedulesByDate).forEach(dateStr => {
                    response += `*${dateStr}*\n`;
                    
                    schedulesByDate[dateStr].forEach((schedule, index) => {
                      // Format times properly
                      let startTimeStr = schedule.startTimeString || 
                        (schedule.startTime ? new Date(schedule.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A');
                      
                      let endTimeStr = schedule.endTimeString || 
                        (schedule.endTime ? new Date(schedule.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A');
                      
                      response += `${index + 1}. ${schedule.title}\n`;
                      response += `   Time: ${startTimeStr} - ${endTimeStr}\n`;
                      response += `   Location: ${schedule.location ? schedule.location.name : 'Unknown'}${schedule.location && schedule.location.address ? ', ' + schedule.location.address : ''}${schedule.location && schedule.location.city ? ', ' + schedule.location.city : ''}\n\n`;
                    });
                  });
                } else {
                  // Format for specific date query
                  const dateDescription = queryParams.date || 'today';
                  response = `Hello ${user.name}, here's your schedule for ${dateDescription}:\n\n`;
                  
                  for (const schedule of schedules) {
                    // Format times properly
                    let startTimeStr = schedule.startTimeString || 
                      (schedule.startTime ? new Date(schedule.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A');
                    
                    let endTimeStr = schedule.endTimeString || 
                      (schedule.endTime ? new Date(schedule.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A');
                    
                    response += `- ${schedule.title}\n`;
                    response += `  Time: ${startTimeStr} - ${endTimeStr}\n`;
                    response += `  Location: ${schedule.location ? schedule.location.name : 'Unknown'}${schedule.location && schedule.location.address ? ', ' + schedule.location.address : ''}${schedule.location && schedule.location.city ? ', ' + schedule.location.city : ''}\n\n`;
                  }
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
              // Use query parameters from AI to determine location and time
              const queryParams = conversation.context.queryParams || {};
              let location = null;
              let schedule = null;
              
              // Check if we have a specific location in query parameters
              if (queryParams.location_id) {
                try {
                  const Location = require('../../models/Location');
                  location = await Location.findById(queryParams.location_id);
                } catch (err) {
                  console.error('Error finding location by ID:', err.message);
                }
              }
              
              // If no location found in query params, check for schedule with location
              if (!location) {
                // Determine date to check for schedules
                let queryDate = new Date();
                if (queryParams.date) {
                  const dateParam = queryParams.date.toLowerCase();
                  
                  if (dateParam === 'tomorrow') {
                    queryDate.setDate(queryDate.getDate() + 1);
                  } else if (dateParam !== 'today') {
                    // Try to parse as a specific date
                    try {
                      const specificDate = new Date(dateParam);
                      if (!isNaN(specificDate.getTime())) {
                        queryDate = specificDate;
                      }
                    } catch (e) {
                      // Invalid date format, use today (already set)
                    }
                  }
                }
                
                // Set up date range for the query
                queryDate.setHours(0, 0, 0, 0);
                const nextDay = new Date(queryDate);
                nextDay.setDate(queryDate.getDate() + 1);
                
                // Find schedules for the determined date
                const schedules = await Schedule.find({
                  assignedEmployees: user._id,
                  date: { $gte: queryDate, $lt: nextDay }
                }).populate('location');
                
                if (schedules.length > 0) {
                  // Use the first schedule with a valid location
                  for (const s of schedules) {
                    if (s.location && s.location.coordinates) {
                      schedule = s;
                      location = s.location;
                      break;
                    }
                  }
                }
              }
              
              // If we still don't have a location, check conversation context
              if (!location && conversation.context.currentLocation) {
                location = conversation.context.currentLocation;
              }
              
              // If we still don't have a location, inform the user
              if (!location) {
                const dateDescription = queryParams.date || 'today';
                response = `I don't have location information to provide traffic updates for ${dateDescription}. Please specify a location or ask about a day when you have a scheduled appointment.`;
              } else {
                try {
                  // Store location in conversation context for future reference
                  conversation.context.currentLocation = location;
                  
                  // Use the mapsService to get real traffic data
                  const { getTrafficData, getRouteInfo } = require('../../utils/mapsService');
                  
                  // Get traffic data for the location
                  const trafficData = await getTrafficData(location.coordinates);
                  
                  // Extract traffic information
                  const trafficLevel = trafficData.flowSegmentData.trafficLevel;
                  const trafficDescription = trafficData.flowSegmentData.trafficLevelDescription || 
                    ['no traffic', 'light traffic', 'moderate traffic', 'heavy traffic', 'severe congestion'][trafficLevel];
                  const currentSpeed = trafficData.flowSegmentData.currentSpeed;
                  const travelTime = trafficData.flowSegmentData.currentTravelTime;
                  
                  // Generate response
                  const dateDescription = queryParams.date || 'today';
                  const scheduleInfo = schedule ? ` for your ${schedule.title} appointment` : '';
                  
                  response = `Traffic update${scheduleInfo} to ${location.name} (${location.address}, ${location.city}) for ${dateDescription}:\n\n`;
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
                  response = `Traffic update for your commute to ${location.name} (${location.address}, ${location.city}):\n\n`;
                  response += `I'm having trouble getting real-time traffic data right now.\n`;
                  response += `Please check a traffic app for the most current conditions.`;
                }
              }
            } else if (intent === 'route_query') {
              // Use query parameters from AI to determine location and origin
              const queryParams = conversation.context.queryParams || {};
              let location = null;
              let schedule = null;
              let origin = null;
              
              // Check if we have origin coordinates in query parameters
              if (queryParams.origin_coordinates) {
                origin = queryParams.origin_coordinates;
              }
              
              // Check if we have a specific location in query parameters
              if (queryParams.location_id) {
                try {
                  const Location = require('../../models/Location');
                  location = await Location.findById(queryParams.location_id);
                } catch (err) {
                  console.error('Error finding location by ID:', err.message);
                }
              }
              
              // If no location found in query params, check for schedule with location
              if (!location) {
                // Determine date to check for schedules
                let queryDate = new Date();
                if (queryParams.date) {
                  const dateParam = queryParams.date.toLowerCase();
                  
                  if (dateParam === 'tomorrow') {
                    queryDate.setDate(queryDate.getDate() + 1);
                  } else if (dateParam !== 'today') {
                    // Try to parse as a specific date
                    try {
                      const specificDate = new Date(dateParam);
                      if (!isNaN(specificDate.getTime())) {
                        queryDate = specificDate;
                      }
                    } catch (e) {
                      // Invalid date format, use today (already set)
                    }
                  }
                }
                
                // Set up date range for the query
                queryDate.setHours(0, 0, 0, 0);
                const nextDay = new Date(queryDate);
                nextDay.setDate(queryDate.getDate() + 1);
                
                // Find schedules for the determined date
                const schedules = await Schedule.find({
                  assignedEmployees: user._id,
                  date: { $gte: queryDate, $lt: nextDay }
                }).populate('location');
                
                if (schedules.length > 0) {
                  // Use the first schedule with a valid location
                  for (const s of schedules) {
                    if (s.location && s.location.coordinates) {
                      schedule = s;
                      location = s.location;
                      break;
                    }
                  }
                }
              }
              
              // If we still don't have a location, check conversation context
              if (!location && conversation.context.currentLocation) {
                location = conversation.context.currentLocation;
              }
              
              // If we still don't have a location, inform the user
              if (!location) {
                const dateDescription = queryParams.date || 'today';
                response = `I don't have destination information to provide route options for ${dateDescription}. Please specify a location or ask about a day when you have a scheduled appointment.`;
              } else {
                try {
                  // Store location in conversation context for future reference
                  conversation.context.currentLocation = location;
                  
                  // Use mapsService to get route options
                  const { getRouteInfo } = require('../../utils/mapsService');
                  
                  // If no origin provided, use a default origin for demo purposes
                  // In a real app, you might ask the user for their current location
                  if (!origin) {
                    origin = {
                      latitude: location.coordinates.latitude - 0.05,
                      longitude: location.coordinates.longitude - 0.05
                    };
                  }
                  
                  const routeData = await getRouteInfo(origin, location.coordinates);
                  
                  // Generate response
                  const dateDescription = queryParams.date || 'today';
                  const scheduleInfo = schedule ? ` for your ${schedule.title} appointment` : '';
                  
                  response = `Route options${scheduleInfo} to ${location.name} (${location.address}, ${location.city}) for ${dateDescription}:\n\n`;
                  
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
                    
                    // Add route description if available
                    if (route.guidance && route.guidance.instructions && route.guidance.instructions.length > 0) {
                      response += `\n`;
                      response += `Main directions: `;
                      
                      // Add first 2-3 major instructions
                      const majorInstructions = route.guidance.instructions
                        .filter(instruction => instruction.routeOffsetInMeters > 500)
                        .slice(0, 3);
                      
                      majorInstructions.forEach((instruction, i) => {
                        if (i > 0) response += ` → `;
                        response += instruction.message;
                      });
                    }
                    
                    response += `\n\n`;
                  });
                  
                  // Store route data in conversation context
                  conversation.context.routeData = routeData;
                  
                  // Add transportation mode options if available
                  if (queryParams.transportation_mode) {
                    response += `Note: These directions are optimized for ${queryParams.transportation_mode} travel.\n`;
                  } else {
                    response += `For alternative transportation options, you can ask about public transit, walking, or cycling routes.\n`;
                  }
                } catch (routeErr) {
                  console.error('Route options error:', routeErr.message);
                  response = `I'm having trouble getting route options right now. Please try again later.`;
                }
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
            } else if (intent === 'employee_query') {
              // Handle employee queries about themselves
              // This intent allows employees to query their own information
              const queryParams = conversation.context.queryParams || {};
              
              // Determine what information the employee is requesting
              const isProfileQuery = (
                messageContent.toLowerCase().includes('my profile') ||
                messageContent.toLowerCase().includes('my information') ||
                messageContent.toLowerCase().includes('my details') ||
                messageContent.toLowerCase().includes('my account') ||
                messageContent.toLowerCase().includes('about me')
              );
              
              if (isProfileQuery) {
                // Return the employee's own profile information
                response = `*Your Profile Information*\n\n`;
                response += `Name: ${user.name}\n`;
                response += `Role: ${user.role}\n`;
                response += `Department: ${user.department || 'Not specified'}\n`;
                response += `Position: ${user.position || 'Not specified'}\n`;
                response += `Email: ${user.email || 'Not specified'}\n`;
                response += `Phone: ${user.phone || 'Not specified'}\n`;
              } else {
                // Default response for employee queries
                response = `Hello ${user.name}, what specific information would you like to know about your profile? You can ask about your details, schedules, or absences.`;
              }
            } else if (intent === 'absence_request') {
              // Use query parameters from AI to determine absence details
              const queryParams = conversation.context.queryParams || {};
              
              try {
                // Extract absence details from query parameters or message
                const Absence = require('../../models/Absence');
                
                // Determine absence type from query parameters
                const absenceType = queryParams.absence_type || 'personal';
                
                // Validate absence type
                const validTypes = ['personal', 'sick', 'vacation', 'family', 'other'];
                const normalizedType = absenceType.toLowerCase();
                const finalType = validTypes.includes(normalizedType) ? normalizedType : 'personal';
                
                // Create a new absence request
                const absence = new Absence({
                  user: user._id,
                  type: finalType,
                  status: 'pending',
                  requestedVia: 'whatsapp',
                  notes: messageContent
                });
                
                // Determine start date from query parameters or message
                let startDate;
                if (queryParams.start_date) {
                  // Try to parse the start date from query parameters
                  try {
                    startDate = new Date(queryParams.start_date);
                    if (isNaN(startDate.getTime())) {
                      // Invalid date format, try to handle special cases
                      if (queryParams.start_date.toLowerCase() === 'today') {
                        startDate = new Date();
                      } else if (queryParams.start_date.toLowerCase() === 'tomorrow') {
                        startDate = new Date();
                        startDate.setDate(startDate.getDate() + 1);
                      } else {
                        // Default to today if we can't parse the date
                        startDate = new Date();
                      }
                    }
                  } catch (e) {
                    startDate = new Date(); // Default to today on error
                  }
                } else {
                  // Try to extract dates from the message using regex as fallback
                  const dateRegex = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/g;
                  const dates = messageContent.match(dateRegex);
                  
                  if (dates && dates.length > 0) {
                    try {
                      startDate = new Date(dates[0]);
                      if (isNaN(startDate.getTime())) {
                        startDate = new Date(); // Default to today if invalid
                      }
                    } catch (e) {
                      startDate = new Date(); // Default to today on error
                    }
                  } else {
                    startDate = new Date(); // Default to today if no dates found
                  }
                }
                
                // Determine end date from query parameters or message
                let endDate;
                if (queryParams.end_date) {
                  // Try to parse the end date from query parameters
                  try {
                    endDate = new Date(queryParams.end_date);
                    if (isNaN(endDate.getTime())) {
                      endDate = startDate; // Default to start date if invalid
                    }
                  } catch (e) {
                    endDate = startDate; // Default to start date on error
                  }
                } else if (queryParams.duration) {
                  // Calculate end date based on duration (in days)
                  try {
                    const duration = parseInt(queryParams.duration);
                    if (!isNaN(duration) && duration > 0) {
                      endDate = new Date(startDate);
                      endDate.setDate(startDate.getDate() + duration - 1); // -1 because start day counts as day 1
                    } else {
                      endDate = startDate; // Default to start date if invalid duration
                    }
                  } catch (e) {
                    endDate = startDate; // Default to start date on error
                  }
                } else {
                  // Try to extract end date from message as fallback
                  const dateRegex = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/g;
                  const dates = messageContent.match(dateRegex);
                  
                  if (dates && dates.length > 1) {
                    try {
                      endDate = new Date(dates[1]);
                      if (isNaN(endDate.getTime())) {
                        endDate = startDate; // Default to start date if invalid
                      }
                    } catch (e) {
                      endDate = startDate; // Default to start date on error
                    }
                  } else {
                    endDate = startDate; // Default to start date if no end date found
                  }
                }
                
                // Ensure end date is not before start date
                if (endDate < startDate) {
                  endDate = startDate;
                }
                
                // Set the dates in the absence object
                absence.startDate = startDate;
                absence.endDate = endDate;
                
                // Determine reason from query parameters or message
                let reason = queryParams.reason;
                
                if (!reason) {
                  // Extract reason from message as fallback
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
                  
                  // If no reason found, use the whole message or a default
                  if (!reason) {
                    reason = messageContent.length > 20 ? messageContent : "No specific reason provided";
                  }
                }
                
                absence.reason = reason;
                
                // Save the absence request
                await absence.save();
                
                // Format dates for response and notifications
                const startDateStr = startDate.toLocaleDateString();
                const endDateStr = endDate.toLocaleDateString();
                
                // Calculate duration for response
                const durationMs = endDate.getTime() - startDate.getTime();
                const durationDays = Math.floor(durationMs / (1000 * 60 * 60 * 24)) + 1; // +1 because both start and end dates are inclusive
                
                // Notify admin about the new absence request
                const admins = await User.find({ role: 'admin' });
                for (const admin of admins) {
                  if (admin.whatsappId || admin.phone) {
                    const recipientId = admin.whatsappId || admin.phone;
                    const adminNotification = `New ${finalType} absence request from ${user.name} (${user.department || 'N/A'}):\n\n` +
                      `Dates: ${startDateStr}${startDateStr !== endDateStr ? ` to ${endDateStr}` : ''} (${durationDays} day${durationDays !== 1 ? 's' : ''})\n` +
                      `Reason: ${reason}\n\n` +
                      `Reply to this message to approve or deny.`;
                    
                    try {
                      await sendWhatsAppMessage(recipientId, adminNotification);
                    } catch (notifyError) {
                      console.error('Error notifying admin about new absence request:', notifyError.message);
                      // Continue execution even if notification fails
                    }
                  }
                }
                
                // Respond to the user
                if (startDateStr === endDateStr) {
                  response = `Thank you! Your ${finalType} absence request for ${startDateStr} has been submitted and is pending approval. ` +
                            `You will be notified once it has been processed.`;
                } else {
                  response = `Thank you! Your ${finalType} absence request from ${startDateStr} to ${endDateStr} (${durationDays} day${durationDays !== 1 ? 's' : ''}) ` +
                            `has been submitted and is pending approval. You will be notified once it has been processed.`;
                }
              } catch (absenceErr) {
                console.error('Absence request error:', absenceErr.message);
                response = `I'm sorry, I couldn't process your absence request. Please try again with a clearer message ` +
                          `or contact your administrator directly.`;
              }
            } else if (intent === 'employee_query') {
              // Use query parameters from AI to determine query type and filters
              const queryParams = conversation.context.queryParams || {};
              
              // Determine query type from parameters or message content
              const queryType = queryParams.query_type || 'unknown';
              
              // Determine if this is a working or absence query
              const isWorkingQuery = (
                queryType === 'working' ||
                messageContent.toLowerCase().includes('working today') ||
                messageContent.toLowerCase().includes('on duty') ||
                messageContent.toLowerCase().includes('on shift') ||
                messageContent.toLowerCase().includes('who is working') ||
                messageContent.toLowerCase().includes('employees today')
              );
              
              const isAbsenceQuery = (
                queryType === 'absent' ||
                messageContent.toLowerCase().includes('absent') ||
                messageContent.toLowerCase().includes('not working') ||
                messageContent.toLowerCase().includes('off today') ||
                messageContent.toLowerCase().includes('on leave') ||
                messageContent.toLowerCase().includes('sick')
              );
              
              // Determine date to query
              let queryDate = new Date();
              if (queryParams.date) {
                const dateParam = queryParams.date.toLowerCase();
                
                if (dateParam === 'tomorrow') {
                  queryDate.setDate(queryDate.getDate() + 1);
                } else if (dateParam !== 'today') {
                  // Try to parse as a specific date
                  try {
                    const specificDate = new Date(dateParam);
                    if (!isNaN(specificDate.getTime())) {
                      queryDate = specificDate;
                    }
                  } catch (e) {
                    // Invalid date format, use today (already set)
                  }
                }
              }
              
              // Set up date range for the query
              queryDate.setHours(0, 0, 0, 0);
              const nextDay = new Date(queryDate);
              nextDay.setDate(queryDate.getDate() + 1);
              
              // Format date for response
              const dateDescription = queryParams.date || 'today';
              const formattedDate = queryDate.toLocaleDateString(undefined, { 
                weekday: 'long', 
                month: 'long', 
                day: 'numeric' 
              });
              
              // Department filter if specified
              const departmentFilter = queryParams.department || null;
              
              if (isWorkingQuery) {
                // Find schedules for the specified date
                const scheduleQuery = {
                  date: { $gte: queryDate, $lt: nextDay },
                  status: { $ne: 'cancelled' }
                };
                
                // Add location filter if specified
                if (queryParams.location_id) {
                  scheduleQuery.location = queryParams.location_id;
                }
                
                const schedules = await Schedule.find(scheduleQuery)
                  .populate('assignedEmployees', 'name department position')
                  .populate('location', 'name');
                
                if (schedules.length === 0) {
                  response = `There are no employees scheduled to work for ${dateDescription}.`;
                } else {
                  // Extract unique employees from all schedules
                  const workingEmployees = new Map();
                  
                  schedules.forEach(schedule => {
                    if (schedule.assignedEmployees && schedule.assignedEmployees.length > 0) {
                      schedule.assignedEmployees.forEach(employee => {
                        // Apply department filter if specified
                        if (departmentFilter && 
                            employee.department && 
                            !employee.department.toLowerCase().includes(departmentFilter.toLowerCase())) {
                          return; // Skip this employee
                        }
                        
                        // Use employee ID as key to avoid duplicates
                        if (!workingEmployees.has(employee._id.toString())) {
                          workingEmployees.set(employee._id.toString(), {
                            name: employee.name,
                            department: employee.department || 'N/A',
                            position: employee.position || 'N/A',
                            schedule: schedule.title,
                            location: schedule.location ? schedule.location.name : 'Unknown'
                          });
                        }
                      });
                    }
                  });
                  
                  if (workingEmployees.size === 0) {
                    if (departmentFilter) {
                      response = `There are no employees from the ${departmentFilter} department scheduled to work for ${dateDescription}.`;
                    } else {
                      response = `There are no employees assigned to schedules for ${dateDescription}.`;
                    }
                  } else {
                    // Group employees by department for better readability
                    const employeesByDept = {};
                    
                    workingEmployees.forEach(employee => {
                      if (!employeesByDept[employee.department]) {
                        employeesByDept[employee.department] = [];
                      }
                      employeesByDept[employee.department].push(employee);
                    });
                    
                    // Build response
                    if (departmentFilter) {
                      response = `*${departmentFilter} Department Employees Working on ${formattedDate} (${workingEmployees.size} total)*\n\n`;
                    } else {
                      response = `*Employees Working on ${formattedDate} (${workingEmployees.size} total)*\n\n`;
                    }
                    
                    Object.keys(employeesByDept).forEach(dept => {
                      response += `*${dept}*\n`;
                      
                      employeesByDept[dept].forEach((employee, index) => {
                        response += `${index + 1}. ${employee.name}`;
                        if (employee.position !== 'N/A') {
                          response += ` (${employee.position})`;
                        }
                        response += `\n   Schedule: ${employee.schedule}`;
                        response += `\n   Location: ${employee.location}\n`;
                      });
                      
                      response += `\n`;
                    });
                  }
                }
              } else if (isAbsenceQuery) {
                // Find absences for the specified date
                const Absence = require('../../models/Absence');
                const absenceQuery = {
                  startDate: { $lte: nextDay },
                  endDate: { $gte: queryDate },
                  status: 'approved'
                };
                
                const absences = await Absence.find(absenceQuery)
                  .populate('user', 'name department position');
                
                // Filter by department if specified
                const filteredAbsences = departmentFilter 
                  ? absences.filter(absence => 
                      absence.user.department && 
                      absence.user.department.toLowerCase().includes(departmentFilter.toLowerCase()))
                  : absences;
                
                if (filteredAbsences.length === 0) {
                  if (departmentFilter) {
                    response = `There are no approved absences from the ${departmentFilter} department for ${dateDescription}.`;
                  } else {
                    response = `There are no approved absences for ${dateDescription}.`;
                  }
                } else {
                  // Group absences by type for better readability
                  const absencesByType = {};
                  
                  filteredAbsences.forEach(absence => {
                    const type = absence.type || 'other';
                    
                    if (!absencesByType[type]) {
                      absencesByType[type] = [];
                    }
                    
                    absencesByType[type].push({
                      name: absence.user.name,
                      department: absence.user.department || 'N/A',
                      position: absence.user.position || 'N/A',
                      reason: absence.reason,
                      startDate: new Date(absence.startDate).toLocaleDateString(),
                      endDate: new Date(absence.endDate).toLocaleDateString()
                    });
                  });
                  
                  // Build response
                  if (departmentFilter) {
                    response = `*${departmentFilter} Department Employees Absent on ${formattedDate} (${filteredAbsences.length} total)*\n\n`;
                  } else {
                    response = `*Employees Absent on ${formattedDate} (${filteredAbsences.length} total)*\n\n`;
                  }
                  
                  Object.keys(absencesByType).forEach(type => {
                    response += `*${type.charAt(0).toUpperCase() + type.slice(1)} Leave*\n`;
                    
                    absencesByType[type].forEach((absence, index) => {
                      response += `${index + 1}. ${absence.name}`;
                      if (absence.department !== 'N/A') {
                        response += ` (${absence.department})`;
                      }
                      response += `\n   Period: ${absence.startDate}`;
                      
                      if (absence.startDate !== absence.endDate) {
                        response += ` to ${absence.endDate}`;
                      }
                      
                      if (absence.reason) {
                        response += `\n   Reason: ${absence.reason}`;
                      }
                      
                      response += `\n\n`;
                    });
                  });
                }
              } else {
                // General employee query - provide summary of both working and absent
                // Define today and tomorrow for date range queries
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const tomorrow = new Date(today);
                tomorrow.setDate(today.getDate() + 1);
                
                const todaySchedules = await Schedule.find({
                  date: { $gte: today, $lt: tomorrow },
                  status: { $ne: 'cancelled' }
                }).populate('assignedEmployees', 'name');
                
                const Absence = require('../../models/Absence');
                const todayAbsences = await Absence.find({
                  startDate: { $lte: tomorrow },
                  endDate: { $gte: today },
                  status: 'approved'
                }).populate('user', 'name');
                
                // Count unique employees working today
                const workingEmployees = new Set();
                todaySchedules.forEach(schedule => {
                  if (schedule.assignedEmployees && schedule.assignedEmployees.length > 0) {
                    schedule.assignedEmployees.forEach(employee => {
                      workingEmployees.add(employee._id.toString());
                    });
                  }
                });
                
                // Count employees absent today
                const absentEmployees = new Set();
                todayAbsences.forEach(absence => {
                  absentEmployees.add(absence.user._id.toString());
                });
                
                response = `*Employee Status Summary for Today*\n\n`;
                response += `Employees working: ${workingEmployees.size}\n`;
                response += `Employees absent: ${absentEmployees.size}\n\n`;
                response += `For detailed information, ask:\n`;
                response += `- "Who is working today?"\n`;
                response += `- "Who is absent today?"\n`;
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
    // Check if user is admin - this is a secondary check as the route already checks
    if (user.role !== 'admin') {
      // For non-admin users, provide a way to query their own information
      // Check if they're trying to query user information
      const commandLower = command.toLowerCase();
      if (commandLower.includes('my profile') || 
          commandLower.includes('my information') || 
          commandLower.includes('my details') || 
          commandLower.includes('about me')) {
        // Return the employee's own profile information
        let response = `*Your Profile Information*\n\n`;
        response += `Name: ${user.name}\n`;
        response += `Role: ${user.role}\n`;
        response += `Department: ${user.department || 'Not specified'}\n`;
        response += `Position: ${user.position || 'Not specified'}\n`;
        response += `Email: ${user.email || 'Not specified'}\n`;
        response += `Phone: ${user.phone || 'Not specified'}\n`;
        return response;
      }
      
      return `You don't have permission to access this information. This feature requires administrator privileges.`;
    }
    
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
             commandLower.includes('all users') ||
             (commandLower.includes('tell me') && commandLower.includes('users')) ||
             (commandLower.includes('users') && commandLower.includes('phone')) ||
             (commandLower.includes('users') && commandLower.includes('number'))) {
      action = 'users';
    }
    // Specific user query detection
    else if ((commandLower.includes('user') && (commandLower.includes('named') || commandLower.includes('about') || commandLower.includes('find') || commandLower.includes('get'))) ||
             (commandLower.includes('tell me about') && !commandLower.includes('all')) ||
             (commandLower.includes('show me') && commandLower.includes('user') && !commandLower.includes('all')) ||
             (commandLower.includes('information') && commandLower.includes('user'))) {
      action = 'user_query';
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
    // General collection query detection
    else if (commandLower.includes('collection') || 
             commandLower.includes('database') || 
             commandLower.includes('model') || 
             commandLower.includes('schema') || 
             commandLower.includes('data') || 
             commandLower.includes('information about') || 
             commandLower.includes('tell me about') || 
             commandLower.includes('show me') || 
             commandLower.includes('get') || 
             commandLower.includes('find') ||
             commandLower.includes('all locations') ||
             commandLower.includes('list locations') ||
             commandLower.includes('show locations') ||
             commandLower.includes('give locations')) {
      action = 'collection_query';
    }
    else {
      // Default to help if command not recognized
      return `I couldn't understand your admin command. Try asking for "admin help" to see available commands.`;
    }
    
    // Split command into parts for parameter extraction
    const parts = command.split(' ');
    
    // Handle different admin commands
    switch (action) {
      case 'collection_query':
        try {
          // Import required modules
          const { generateMongoDBPipeline } = require('../../utils/aiService');
          
          // Collect all model schemas for the AI service
          const modelSchemas = {
            user: User,
            schedule: Schedule,
            location: Location,
            absence: Absence,
            conversation: Conversation,
            hourTracking: HourTracking
          };
          
          console.log(`Processing collection query with AI: "${command}"`);
          
          // Generate MongoDB aggregation pipeline using Azure OpenAI
          const pipelineResult = await generateMongoDBPipeline(command, user, modelSchemas);
          
          // Handle unclear queries
          if (pipelineResult.unclear) {
            return `I'm not sure what you're asking for. Could you please be more specific about which data you want to query?`;
          }
          
          // Handle errors in pipeline generation
          if (pipelineResult.error) {
            console.error('Pipeline generation error:', pipelineResult.message);
            return `I encountered an error while processing your query: ${pipelineResult.message}`;
          }
          
          // Get the primary model to query
          const modelName = pipelineResult.model;
          const pipeline = pipelineResult.pipeline;
          
          if (!modelName || !pipeline) {
            return `I couldn't determine what you're asking for. Please try rephrasing your query.`;
          }
          
          // Get the appropriate model
          let Model;
          let collectionName = modelName;
          
          switch (modelName) {
            case 'user':
              Model = User;
              break;
            case 'schedule':
              Model = Schedule;
              break;
            case 'location':
              Model = Location;
              break;
            case 'absence':
              Model = Absence;
              break;
            case 'conversation':
              Model = Conversation;
              break;
            case 'hourTracking':
              Model = HourTracking;
              break;
            default:
              return `I don't recognize the collection "${modelName}". Please specify a valid collection like users, schedules, locations, or absences.`;
          }
          
          console.log(`Executing aggregation pipeline for ${modelName}:`, JSON.stringify(pipeline));
          
          // Execute the aggregation pipeline
          const results = await Model.aggregate(pipeline).exec();
          
          if (results.length === 0) {
            return `No ${collectionName} records found matching your query.`;
          }
          
          // Format the response based on the collection
          let response = `*${collectionName.charAt(0).toUpperCase() + collectionName.slice(1)} Query Results*\n\n`;
          
          switch (collectionName) {
            case 'user':
              results.forEach((u, index) => {
                response += `${index + 1}. ${u.name} (${u.role || 'N/A'})\n`;
                response += `   ID: ${u._id}\n`;
                response += `   Dept: ${u.department || 'N/A'}\n`;
                response += `   Position: ${u.position || 'N/A'}\n`;
                response += `   Email: ${u.email || 'N/A'}\n`;
                response += `   Phone: ${u.phone || 'N/A'}\n\n`;
              });
              break;
              
            case 'schedule':
              results.forEach((s, index) => {
                const date = s.date ? new Date(s.date).toLocaleDateString() : 'N/A';
                const startTime = s.startTime ? new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
                const endTime = s.endTime ? new Date(s.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
                
                response += `${index + 1}. ${s.title || 'Untitled'}\n`;
                response += `   Date: ${date}\n`;
                response += `   Time: ${startTime} - ${endTime}\n`;
                
                if (s.location) {
                  if (typeof s.location === 'object' && s.location.name) {
                    response += `   Location: ${s.location.name}\n`;
                  } else if (typeof s.location === 'string') {
                    response += `   Location ID: ${s.location}\n`;
                  }
                }
                
                if (s.assignedEmployees && s.assignedEmployees.length > 0) {
                  const employeeNames = s.assignedEmployees.map(e => {
                    if (typeof e === 'object' && e.name) return e.name;
                    return e;
                  }).join(', ');
                  response += `   Assigned: ${employeeNames}\n`;
                }
                
                response += `\n`;
              });
              break;
              
            case 'location':
              results.forEach((l, index) => {
                response += `${index + 1}. ${l.name || 'Unnamed Location'}\n`;
                response += `   Address: ${l.address || 'N/A'}, ${l.city || 'N/A'}, ${l.state || 'N/A'} ${l.zipCode || 'N/A'}\n`;
                if (l.coordinates) {
                  response += `   Coordinates: ${l.coordinates.latitude || 'N/A'}, ${l.coordinates.longitude || 'N/A'}\n`;
                }
                if (l.createdBy) {
                  if (typeof l.createdBy === 'object' && l.createdBy.name) {
                    response += `   Created By: ${l.createdBy.name}\n`;
                  } else if (typeof l.createdBy === 'string') {
                    response += `   Created By ID: ${l.createdBy}\n`;
                  }
                }
                response += `\n`;
              });
              break;
              
            case 'absence':
              results.forEach((a, index) => {
                const startDate = a.startDate ? new Date(a.startDate).toLocaleDateString() : 'N/A';
                const endDate = a.endDate ? new Date(a.endDate).toLocaleDateString() : 'N/A';
                
                let userName = 'Unknown User';
                if (a.user) {
                  if (typeof a.user === 'object' && a.user.name) {
                    userName = a.user.name;
                  } else if (typeof a.user === 'string') {
                    userName = `User ID: ${a.user}`;
                  }
                }
                
                response += `${index + 1}. ${userName}\n`;
                response += `   Type: ${a.type || 'N/A'}\n`;
                response += `   Dates: ${startDate} to ${endDate}\n`;
                response += `   Status: ${a.status || 'N/A'}\n`;
                response += `   Reason: ${a.reason || 'N/A'}\n\n`;
              });
              break;
              
            case 'conversation':
              results.forEach((c, index) => {
                const lastUpdated = c.updatedAt ? new Date(c.updatedAt).toLocaleString() : 'N/A';
                
                let userName = 'Unknown User';
                if (c.user) {
                  if (typeof c.user === 'object' && c.user.name) {
                    userName = c.user.name;
                  } else if (typeof c.user === 'string') {
                    userName = `User ID: ${c.user}`;
                  }
                }
                
                response += `${index + 1}. Conversation ID: ${c._id}\n`;
                response += `   User: ${userName}\n`;
                response += `   Platform: ${c.platform || 'N/A'}\n`;
                response += `   Active: ${c.active ? 'Yes' : 'No'}\n`;
                response += `   Last Updated: ${lastUpdated}\n\n`;
              });
              break;
              
            case 'hourTracking':
              results.forEach((h, index) => {
                const date = h.date ? new Date(h.date).toLocaleDateString() : 'N/A';
                const clockIn = h.clockInTime ? new Date(h.clockInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
                const clockOut = h.clockOutTime ? new Date(h.clockOutTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
                
                let userName = 'Unknown User';
                if (h.user) {
                  if (typeof h.user === 'object' && h.user.name) {
                    userName = h.user.name;
                  } else if (typeof h.user === 'string') {
                    userName = `User ID: ${h.user}`;
                  }
                }
                
                response += `${index + 1}. ${userName}\n`;
                response += `   Date: ${date}\n`;
                response += `   Clock In: ${clockIn}\n`;
                response += `   Clock Out: ${clockOut}\n`;
                response += `   Total Hours: ${h.totalHours || 'N/A'}\n\n`;
              });
              break;
              
            default:
              // Generic formatter for any other collection
              results.forEach((item, index) => {
                response += `${index + 1}. ID: ${item._id}\n`;
                
                // Display up to 5 key properties
                const keys = Object.keys(item).filter(k => k !== '_id' && k !== '__v').slice(0, 5);
                keys.forEach(key => {
                  const value = item[key];
                  if (value !== null && value !== undefined) {
                    if (typeof value === 'object' && value instanceof Date) {
                      response += `   ${key}: ${value.toLocaleString()}\n`;
                    } else if (typeof value !== 'object') {
                      response += `   ${key}: ${value}\n`;
                    } else if (value._id) {
                      response += `   ${key} ID: ${value._id}\n`;
                    }
                  }
                });
                
                response += `\n`;
              });
          }
          
          // Process additional models if any
          if (pipelineResult.additionalModels && pipelineResult.additionalModels.length > 0) {
            for (const additionalQuery of pipelineResult.additionalModels) {
              const additionalModelName = additionalQuery.model;
              const additionalPipeline = additionalQuery.pipeline;
              
              if (!additionalModelName || !additionalPipeline) continue;
              
              let AdditionalModel;
              switch (additionalModelName) {
                case 'user': AdditionalModel = User; break;
                case 'schedule': AdditionalModel = Schedule; break;
                case 'location': AdditionalModel = Location; break;
                case 'absence': AdditionalModel = Absence; break;
                case 'conversation': AdditionalModel = Conversation; break;
                case 'hourTracking': AdditionalModel = HourTracking; break;
                default: continue;
              }
              
              const additionalResults = await AdditionalModel.aggregate(additionalPipeline).exec();
              
              if (additionalResults.length > 0) {
                response += `\n*Related ${additionalModelName.charAt(0).toUpperCase() + additionalModelName.slice(1)} Results*\n\n`;
                response += `Found ${additionalResults.length} related records.\n`;
                // We don't format these in detail to keep the response concise
              }
            }
          }
          
          return response;
        } catch (err) {
          console.error(`AI-powered collection query error:`, err);
          return `Error processing your query: ${err.message}. Please try again with a more specific query.`;
        }
        
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
        
      case 'user_query':
        // Extract user name from the command
        let userName = '';
        
        // Pattern: "user named X" or "user X"
        if (commandLower.includes('named')) {
          const namedIndex = commandLower.indexOf('named');
          userName = command.substring(namedIndex + 'named'.length).trim();
        } 
        // Pattern: "about user X" or "about X"
        else if (commandLower.includes('about')) {
          const aboutIndex = commandLower.indexOf('about');
          userName = command.substring(aboutIndex + 'about'.length).trim();
        }
        // Pattern: "find user X" or "get user X"
        else if (commandLower.includes('find user') || commandLower.includes('get user')) {
          const findIndex = commandLower.includes('find user') ? 
            commandLower.indexOf('find user') + 'find user'.length : 
            commandLower.indexOf('get user') + 'get user'.length;
          userName = command.substring(findIndex).trim();
        }
        // Pattern: "tell me about X"
        else if (commandLower.includes('tell me about')) {
          const tellIndex = commandLower.indexOf('tell me about');
          userName = command.substring(tellIndex + 'tell me about'.length).trim();
        }
        // Pattern: "show me user X"
        else if (commandLower.includes('show me user')) {
          const showIndex = commandLower.indexOf('show me user');
          userName = command.substring(showIndex + 'show me user'.length).trim();
        }
        // Pattern: "information about user X"
        else if (commandLower.includes('information about user')) {
          const infoIndex = commandLower.indexOf('information about user');
          userName = command.substring(infoIndex + 'information about user'.length).trim();
        }
        // Fallback: try to extract the last word as the user name
        else {
          const words = command.split(' ');
          userName = words[words.length - 1];
        }
        
        // Clean up the extracted name
        userName = userName.replace(/^[\s,.]+|[\s,.]+$/g, ''); // Remove leading/trailing spaces and punctuation
        
        if (!userName) {
          return 'Please specify a user name. For example: "Tell me about user John" or "Find user named Sarah".';
        }
        
        // Find the user by name (case-insensitive partial match)
        const user = await User.findOne({ 
          name: { $regex: userName, $options: 'i' } 
        }).select('name email phone role department position');
        
        if (!user) {
          return `No user found with name containing "${userName}". Please try again with a different name.`;
        }
        
        // Format user details
        let userDetails = `*User Details: ${user.name}*\n\n`;
        userDetails += `ID: ${user._id}\n`;
        userDetails += `Role: ${user.role}\n`;
        userDetails += `Department: ${user.department || 'N/A'}\n`;
        userDetails += `Position: ${user.position || 'N/A'}\n`;
        userDetails += `Email: ${user.email || 'N/A'}\n`;
        userDetails += `Phone: ${user.phone || 'N/A'}\n`;
        
        return userDetails;
      
      case 'schedules':
        // Check if admin is requesting all schedules regardless of date
        const requestingAllSchedules = (
          commandLower.includes('all schedules') ||
          commandLower.includes('all the schedules') ||
          commandLower.includes('every schedule') ||
          commandLower.includes('irrespective of date') ||
          commandLower.includes('regardless of date') ||
          (commandLower.includes('all') && !commandLower.includes('today') && 
           !commandLower.includes('tomorrow') && !commandLower.includes('yesterday') && 
           !commandLower.includes('next'))
        );
        
        let schedules;
        let scheduleList = '';
        
        if (requestingAllSchedules) {
          // Fetch all schedules without date filtering
          schedules = await Schedule.find({})
            .populate('location assignedEmployees', 'name address city')
            .sort({ date: 1 }); // Sort by date ascending
          
          if (schedules.length === 0) {
            return 'No schedules found in the system.';
          }
          
          scheduleList = `*All Schedules (${schedules.length} total)*\n\n`;
          
          // Group schedules by date for better readability
          const schedulesByDate = {};
          
          schedules.forEach(schedule => {
            const scheduleDate = new Date(schedule.date);
            const dateStr = scheduleDate.toLocaleDateString(undefined, { 
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            });
            
            if (!schedulesByDate[dateStr]) {
              schedulesByDate[dateStr] = [];
            }
            
            schedulesByDate[dateStr].push(schedule);
          });
          
          // Format output by date groups
          Object.keys(schedulesByDate).forEach(dateStr => {
            scheduleList += `*${dateStr}*\n`;
            
            schedulesByDate[dateStr].forEach((schedule, index) => {
              // Format times properly
              let startTimeStr = schedule.startTimeString || 
                (schedule.startTime ? new Date(schedule.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A');
              
              let endTimeStr = schedule.endTimeString || 
                (schedule.endTime ? new Date(schedule.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A');
              
              scheduleList += `${index + 1}. ${schedule.title}\n`;
              scheduleList += `   Time: ${startTimeStr} - ${endTimeStr}\n`;
              scheduleList += `   Location: ${schedule.location ? schedule.location.name : 'Unknown'}\n`;
              scheduleList += `   Employees: ${schedule.assignedEmployees && schedule.assignedEmployees.length > 0 ? 
                schedule.assignedEmployees.map(e => e.name).join(', ') : 'None assigned'}\n\n`;
            });
          });
          
          return scheduleList;
        } else {
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
          schedules = await Schedule.find({
            date: { $gte: targetDate, $lt: nextDay }
          }).populate('location assignedEmployees', 'name address city');
          
          // Format the date for display
          const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
          const formattedDate = targetDate.toLocaleDateString(undefined, dateOptions);
          
          if (schedules.length === 0) {
            return `No schedules found for ${formattedDate}.`;
          }
          
          scheduleList = `*Schedules for ${formattedDate}*\n\n`;
          
          schedules.forEach((schedule, index) => {
            // Format times properly
            let startTimeStr = schedule.startTimeString || 
              (schedule.startTime ? new Date(schedule.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A');
            
            let endTimeStr = schedule.endTimeString || 
              (schedule.endTime ? new Date(schedule.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A');
            
            scheduleList += `${index + 1}. ${schedule.title}\n`;
            scheduleList += `   Time: ${startTimeStr} - ${endTimeStr}\n`;
            scheduleList += `   Location: ${schedule.location ? schedule.location.name : 'Unknown'}\n`;
            scheduleList += `   Employees: ${schedule.assignedEmployees && schedule.assignedEmployees.length > 0 ? 
              schedule.assignedEmployees.map(e => e.name).join(', ') : 'None assigned'}\n\n`;
          });
        }
        
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
            try {
              await sendWhatsAppMessage(u.phone, `*BROADCAST MESSAGE FROM ADMIN*\n\n${broadcastMessage}`);
              sentCount++;
            } catch (broadcastError) {
              console.error(`Failed to send broadcast to ${u.phone}:`, broadcastError.message);
              // Continue with other users even if one fails
            }
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
            // Try to find a natural break point for user and message
            // First check if there's a clear separator like a comma
            const commaIndex = afterNotify.indexOf(',');
            if (commaIndex > 0) {
              userIdentifier = afterNotify.substring(0, commaIndex).trim();
              notifyMessage = afterNotify.substring(commaIndex + 1).trim();
            } else {
              // Extract first word as user and rest as message
              const parts = afterNotify.split(' ');
              if (parts.length >= 2) {
                userIdentifier = parts[0].trim();
                notifyMessage = parts.slice(1).join(' ').trim();
              }
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
          /approve\s+(?:the\s+)?(?:absence|request)\s+(?:from|by|for)\s+([\w\s]+)\s+(?:on|for|dated)\s+([\w\s,]+)/i
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
          try {
            await sendWhatsAppMessage(
              absenceToApprove.user.phone,
              `Your absence request from ${new Date(absenceToApprove.startDate).toLocaleDateString()} to ${new Date(absenceToApprove.endDate).toLocaleDateString()} has been approved.`
            );
          } catch (notifyError) {
            console.error('Error notifying user about approval:', notifyError.message);
            // Continue execution even if notification fails
          }
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
          try {
            await sendWhatsAppMessage(
              absenceToReject.user.phone,
              `Your absence request from ${new Date(absenceToReject.startDate).toLocaleDateString()} to ${new Date(absenceToReject.endDate).toLocaleDateString()} has been rejected.`
            );
          } catch (notifyError) {
            console.error('Error notifying user about rejection:', notifyError.message);
            // Continue execution even if notification fails
          }
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