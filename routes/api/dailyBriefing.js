const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const User = require('../../models/User');
const Schedule = require('../../models/Schedule');
const Location = require('../../models/Location');
const Absence = require('../../models/Absence');
const Notification = require('../../models/Notification');
const { sendEmail } = require('../../utils/emailService');
const { sendWhatsAppMessage, sendWhatsAppTemplate } = require('../../utils/whatsappService');
const { getTrafficData, getRouteInformation } = require('../../utils/mapsService');
const { processMessageWithAI } = require('../../utils/aiService');
const { convertSpeechToText } = require('../../utils/speechService');

// Helper function to get today's date at midnight
const getTodayAtMidnight = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
};

// Helper function to get tomorrow's date at midnight
const getTomorrowAtMidnight = () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow;
};

// Helper function to format time
const formatTime = (timeString) => {
  const [hours, minutes] = timeString.split(':');
  const hour = parseInt(hours);
  const period = hour >= 12 ? 'PM' : 'AM';
  const formattedHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${formattedHour}:${minutes} ${period}`;
};

// @route   GET api/daily-briefing
// @desc    Get daily briefing for current user
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    // Get user with populated language settings and default location
    const user = await User.findById(req.user.id)
      .populate('languageSettings')
      .populate('defaultLocation');

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Get today's date at midnight
    const today = getTodayAtMidnight();
    const tomorrow = getTomorrowAtMidnight();

    // Get user's schedules for today
    const schedules = await Schedule.find({
      assignedEmployees: req.user.id,
      date: {
        $gte: today,
        $lt: tomorrow
      }
    }).populate('location');

    // Get user's absences for today
    const absences = await Absence.find({
      user: req.user.id,
      startDate: { $lte: today },
      endDate: { $gte: today },
      status: 'approved'
    }).populate('schedule');

    // Check if user has any approved absences that conflict with today's schedules
    const absentScheduleIds = absences.map(absence => absence.schedule._id.toString());
    const filteredSchedules = schedules.filter(schedule => 
      !absentScheduleIds.includes(schedule._id.toString())
    );

    // Get traffic information if user has a default location and schedules
    let trafficInfo = [];
    if (user.defaultLocation && filteredSchedules.length > 0) {
      for (const schedule of filteredSchedules) {
        if (schedule.location) {
          try {
            const traffic = await getTrafficData(
              user.defaultLocation.coordinates,
              schedule.location.coordinates
            );

            const route = await getRouteInformation(
              user.defaultLocation.coordinates,
              schedule.location.coordinates
            );

            trafficInfo.push({
              scheduleId: schedule._id,
              scheduleTitle: schedule.title,
              startTime: schedule.startTime,
              location: schedule.location.name,
              trafficCondition: traffic.trafficCondition,
              estimatedTravelTime: traffic.travelTimeMinutes,
              distance: route.distanceInKilometers,
              suggestedDepartureTime: calculateDepartureTime(schedule.startTime, traffic.travelTimeMinutes)
            });
          } catch (error) {
            console.error(`Error getting traffic data for schedule ${schedule._id}:`, error);
          }
        }
      }
    }

    // Format schedules for response
    const formattedSchedules = filteredSchedules.map(schedule => ({
      id: schedule._id,
      title: schedule.title,
      description: schedule.description,
      date: schedule.date,
      startTime: formatTime(schedule.startTime),
      endTime: formatTime(schedule.endTime),
      location: schedule.location ? {
        name: schedule.location.name,
        address: schedule.location.address,
        city: schedule.location.city
      } : null
    }));

    // Create briefing response
    const briefing = {
      date: today,
      user: {
        name: user.name,
        department: user.department,
        position: user.position
      },
      schedules: formattedSchedules,
      trafficInfo,
      absences: absences.map(absence => ({
        id: absence._id,
        schedule: {
          id: absence.schedule._id,
          title: absence.schedule.title
        },
        startDate: absence.startDate,
        endDate: absence.endDate,
        status: absence.status
      }))
    };

    res.json(briefing);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Helper function to calculate suggested departure time
function calculateDepartureTime(startTime, travelTimeMinutes) {
  const [hours, minutes] = startTime.split(':').map(Number);
  
  // Create a date object for today with the schedule start time
  const startDateTime = new Date();
  startDateTime.setHours(hours, minutes, 0, 0);
  
  // Subtract travel time (adding 10 minutes buffer)
  const departureTime = new Date(startDateTime.getTime() - ((travelTimeMinutes + 10) * 60 * 1000));
  
  // Format departure time
  const departureHours = departureTime.getHours();
  const departureMinutes = departureTime.getMinutes();
  const period = departureHours >= 12 ? 'PM' : 'AM';
  const formattedHour = departureHours % 12 === 0 ? 12 : departureHours % 12;
  const formattedMinutes = departureMinutes.toString().padStart(2, '0');
  
  return `${formattedHour}:${formattedMinutes} ${period}`;
}

// @route   POST api/daily-briefing/send
// @desc    Send daily briefing to user
// @access  Private/Admin
router.post('/send', auth, async (req, res) => {
  const { userId, notificationType } = req.body;
  
  try {
    // Check if admin or self
    if (req.user.role !== 'admin' && req.user.id !== userId) {
      return res.status(401).json({ msg: 'Not authorized' });
    }
    
    // Get user
    const user = await User.findById(userId)
      .populate('languageSettings')
      .populate('defaultLocation');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // Check if user has daily briefing enabled
    if (!user.notificationPreferences.dailyBriefing) {
      return res.status(400).json({ msg: 'User has not enabled daily briefing' });
    }
    
    // Get today's date at midnight
    const today = getTodayAtMidnight();
    const tomorrow = getTomorrowAtMidnight();
    
    // Get user's schedules for today
    const schedules = await Schedule.find({
      assignedEmployees: userId,
      date: {
        $gte: today,
        $lt: tomorrow
      }
    }).populate('location');
    
    // Get user's absences for today
    const absences = await Absence.find({
      user: userId,
      startDate: { $lte: today },
      endDate: { $gte: today },
      status: 'approved'
    }).populate('schedule');
    
    // Check if user has any approved absences that conflict with today's schedules
    const absentScheduleIds = absences.map(absence => absence.schedule._id.toString());
    const filteredSchedules = schedules.filter(schedule => 
      !absentScheduleIds.includes(schedule._id.toString())
    );
    
    // Get traffic information if user has a default location and schedules
    let trafficInfo = [];
    if (user.defaultLocation && filteredSchedules.length > 0) {
      for (const schedule of filteredSchedules) {
        if (schedule.location) {
          try {
            const traffic = await getTrafficData(
              user.defaultLocation.coordinates,
              schedule.location.coordinates
            );
            
            trafficInfo.push({
              scheduleTitle: schedule.title,
              startTime: formatTime(schedule.startTime),
              location: schedule.location.name,
              trafficCondition: traffic.trafficCondition,
              estimatedTravelTime: traffic.travelTimeMinutes,
              suggestedDepartureTime: calculateDepartureTime(schedule.startTime, traffic.travelTimeMinutes)
            });
          } catch (error) {
            console.error(`Error getting traffic data for schedule ${schedule._id}:`, error);
          }
        }
      }
    }
    
    // Create briefing message
    let briefingMessage = `Good morning ${user.name}! Here's your daily briefing for ${today.toLocaleDateString()}:\n\n`;
    
    if (filteredSchedules.length === 0) {
      briefingMessage += "You don't have any schedules for today.\n";
    } else {
      briefingMessage += `You have ${filteredSchedules.length} schedule(s) today:\n\n`;
      
      filteredSchedules.forEach((schedule, index) => {
        briefingMessage += `${index + 1}. ${schedule.title}\n`;
        briefingMessage += `   Time: ${formatTime(schedule.startTime)} - ${formatTime(schedule.endTime)}\n`;
        if (schedule.location) {
          briefingMessage += `   Location: ${schedule.location.name}, ${schedule.location.address}\n`;
        }
        
        // Add traffic information if available
        const traffic = trafficInfo.find(t => t.scheduleTitle === schedule.title);
        if (traffic) {
          briefingMessage += `   Traffic: ${traffic.trafficCondition}\n`;
          briefingMessage += `   Estimated travel time: ${traffic.estimatedTravelTime} minutes\n`;
          briefingMessage += `   Suggested departure time: ${traffic.suggestedDepartureTime}\n`;
        }
        
        briefingMessage += '\n';
      });
    }
    
    // Create notification
    const notification = new Notification({
      type: notificationType || (user.notificationPreferences.email && user.notificationPreferences.whatsapp ? 'both' :
            user.notificationPreferences.email ? 'email' : 'whatsapp'),
      recipient: userId,
      subject: `Daily Briefing - ${today.toLocaleDateString()}`,
      content: briefingMessage,
      relatedTo: 'daily-briefing',
      createdBy: req.user.id
    });
    
    await notification.save();
    
    // Send notifications based on type
    if ((notification.type === 'email' || notification.type === 'both') && user.email) {
      await sendEmail(
        user.email,
        `Daily Briefing - ${today.toLocaleDateString()}`,
        briefingMessage.replace(/\n/g, '<br>')
      );
      notification.status = 'sent';
      notification.sentAt = Date.now();
      await notification.save();
    }
    
    if ((notification.type === 'whatsapp' || notification.type === 'both') && user.phone) {
      await sendWhatsAppMessage(
        user.phone,
        briefingMessage
      );
      notification.status = 'sent';
      notification.sentAt = Date.now();
      await notification.save();
    }
    
    res.json({ msg: 'Daily briefing sent successfully', notification });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST api/daily-briefing/voice-command
// @desc    Process voice command for daily briefing
// @access  Private
router.post('/voice-command', auth, async (req, res) => {
  try {
    const { audioData, audioFormat } = req.body;
    
    if (!audioData) {
      return res.status(400).json({ msg: 'Audio data is required' });
    }
    
    // Get user with language settings
    const user = await User.findById(req.user.id).populate('languageSettings');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // Determine language for speech recognition
    const recognitionLanguage = user.languageSettings ? 
      user.languageSettings.voiceRecognitionLanguage : 'en-US';
    
    // Convert speech to text
    let transcribedText;
    try {
      transcribedText = await convertSpeechToText(audioData, audioFormat, recognitionLanguage);
    } catch (error) {
      console.error('Error converting speech to text:', error);
      return res.status(500).json({ msg: 'Error processing voice command' });
    }
    
    if (!transcribedText) {
      return res.status(400).json({ msg: 'Could not transcribe audio' });
    }
    
    // Process the transcribed text with AI to determine intent
    const systemMessage = `You are an AI assistant for a scheduling application. 
    The user may ask about their daily briefing, schedules, or traffic information. 
    Identify if the user is asking for their daily briefing, schedule information, or traffic updates.`;
    
    const aiResponse = await processMessageWithAI(transcribedText, systemMessage, {
      userId: req.user.id,
      userName: user.name,
      userRole: user.role,
      userDepartment: user.department
    });
    
    // Check if the intent is related to daily briefing
    const intent = determineIntent(aiResponse);
    
    if (intent.includes('daily-briefing')) {
      // Get daily briefing data
      const today = getTodayAtMidnight();
      const tomorrow = getTomorrowAtMidnight();
      
      // Get user's schedules for today
      const schedules = await Schedule.find({
        assignedEmployees: req.user.id,
        date: {
          $gte: today,
          $lt: tomorrow
        }
      }).populate('location');
      
      // Format response
      let response = `Here's your daily briefing for today, ${user.name}. `;
      
      if (schedules.length === 0) {
        response += "You don't have any schedules for today.";
      } else {
        response += `You have ${schedules.length} schedule(s) today. `;
        
        schedules.forEach((schedule, index) => {
          response += `${index + 1}: ${schedule.title} at ${formatTime(schedule.startTime)}. `;
          if (schedule.location) {
            response += `Location: ${schedule.location.name}. `;
          }
        });
      }
      
      // If user has a default location, add traffic information
      if (user.defaultLocation && schedules.length > 0) {
        const firstSchedule = schedules[0];
        if (firstSchedule.location) {
          try {
            const traffic = await getTrafficData(
              user.defaultLocation.coordinates,
              firstSchedule.location.coordinates
            );
            
            response += `Traffic to your first schedule is ${traffic.trafficCondition.toLowerCase()}. `;
            response += `Estimated travel time is ${traffic.travelTimeMinutes} minutes. `;
            response += `You should leave by ${calculateDepartureTime(firstSchedule.startTime, traffic.travelTimeMinutes)}.`;
          } catch (error) {
            console.error('Error getting traffic data:', error);
          }
        }
      }
      
      return res.json({
        transcribedText,
        intent: 'daily-briefing',
        response
      });
    } else if (intent.includes('schedule')) {
      // Handle schedule-specific queries
      return res.json({
        transcribedText,
        intent: 'schedule',
        response: aiResponse
      });
    } else if (intent.includes('traffic')) {
      // Handle traffic-specific queries
      return res.json({
        transcribedText,
        intent: 'traffic',
        response: aiResponse
      });
    } else {
      // Generic response for unrecognized intents
      return res.json({
        transcribedText,
        intent: 'unknown',
        response: "I'm not sure what you're asking for. You can ask about your daily briefing, schedules, or traffic information."
      });
    }
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Helper function to determine intent from AI response
function determineIntent(aiResponse) {
  const response = aiResponse.toLowerCase();
  
  if (response.includes('daily briefing') || response.includes('briefing') || 
      response.includes('today\'s schedule') || response.includes('today\'s agenda')) {
    return 'daily-briefing';
  } else if (response.includes('schedule') || response.includes('appointment') || 
             response.includes('meeting')) {
    return 'schedule';
  } else if (response.includes('traffic') || response.includes('commute') || 
             response.includes('travel time')) {
    return 'traffic';
  }
  
  return 'unknown';
}

// @route   PUT api/daily-briefing/preferences
// @desc    Update user's daily briefing preferences
// @access  Private
router.put('/preferences', auth, async (req, res) => {
  const { dailyBriefing, briefingTime } = req.body;
  
  try {
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // Update daily briefing preferences
    if (dailyBriefing !== undefined) {
      user.notificationPreferences.dailyBriefing = dailyBriefing;
    }
    
    if (briefingTime) {
      user.notificationPreferences.briefingTime = briefingTime;
    }
    
    await user.save();
    
    res.json(user.notificationPreferences);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;