const twilio = require('twilio');

// Create Twilio client
const createTwilioClient = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials not configured');
  }
  
  return twilio(accountSid, authToken);
};

/**
 * Send WhatsApp message using Twilio
 * @param {string} to - Recipient phone number (format: +1234567890)
 * @param {string} message - Message content
 */
const sendWhatsAppMessage = async (to, message) => {
  try {
    const client = createTwilioClient();
    const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
    
    if (!twilioPhoneNumber) {
      throw new Error('Twilio phone number not configured');
    }
    
    // Format phone number for WhatsApp
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    
    const messageResponse = await client.messages.create({
      body: message,
      from: `whatsapp:${twilioPhoneNumber}`,
      to: formattedTo
    });
    
    console.log('WhatsApp message sent:', messageResponse.sid);
    return messageResponse;
  } catch (error) {
    console.error('WhatsApp sending error:', error.message);
    throw error;
  }
};

/**
 * Send schedule notification via WhatsApp
 * @param {Object} user - User object
 * @param {Object} schedule - Schedule object
 * @param {Object} location - Location object
 */
const sendScheduleWhatsApp = async (user, schedule, location) => {
  const message = `
Hello ${user.name},

You have been assigned to the following schedule:

Title: ${schedule.title}
Date: ${new Date(schedule.date).toLocaleDateString()}
Time: ${schedule.startTime} - ${schedule.endTime}
Location: ${location.name}, ${location.address}, ${location.city}

Reply to this message if you have any questions.
`;
  
  return sendWhatsAppMessage(user.phone, message);
};

module.exports = {
  sendWhatsAppMessage,
  sendScheduleWhatsApp
};