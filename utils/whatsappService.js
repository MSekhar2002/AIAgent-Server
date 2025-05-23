const axios = require('axios');

// Create Meta WhatsApp API client
const createMetaClient = () => {
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  
  if (!token || !phoneNumberId) {
    throw new Error('Meta WhatsApp credentials not configured');
  }
  
  return {
    token,
    phoneNumberId,
    apiUrl: `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`
  };
};

/**
 * Send WhatsApp message using Meta WhatsApp Cloud API
 * @param {string} to - Recipient phone number (format: +1234567890)
 * @param {string} message - Message content
 */
const sendWhatsAppMessage = async (to, message) => {
  try {
    const client = createMetaClient();
    
    // Format phone number for WhatsApp (remove any 'whatsapp:' prefix if present)
    const formattedTo = to.replace('whatsapp:', '');
    
    const response = await axios.post(
      client.apiUrl,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: formattedTo,
        type: 'text',
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${client.token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('WhatsApp message sent:', response.data.messages[0].id);
    return response.data;
  } catch (error) {
    console.error('WhatsApp sending error:', error.response?.data || error.message);
    throw error;
  }
};

/**
 * Send WhatsApp template message using Meta WhatsApp Cloud API
 * @param {string} to - Recipient phone number (format: +1234567890)
 * @param {string} templateName - Name of the template
 * @param {string} languageCode - Language code (e.g., en)
 * @param {Object|Array} parameters - Parameters for the template (object with named parameters or array for backward compatibility)
 */

const sendWhatsAppTemplate = async (to, templateName, languageCode, parameters) => {
  try {
    const client = createMetaClient(); // Your custom function to get Meta API config

    // Remove any 'whatsapp:' prefix from recipient number
    const formattedTo = to.replace('whatsapp:', '');

    const components = [];

    if (parameters) {
      const paramArray = Array.isArray(parameters)
        ? parameters
        : Object.entries(parameters).map(([key, value]) => ({
            parameter_name: key,
            type: 'text',
            text: value
          }));

      components.push({
        type: 'body',
        parameters: paramArray
      });
    }

    const response = await axios.post(
      client.apiUrl,
      {
        messaging_product: 'whatsapp',
        to: formattedTo,
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode
          },
          components
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${client.token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('WhatsApp template message sent:', response.data.messages?.[0]?.id || response.data);
    return response.data;
  } catch (error) {
    console.error('WhatsApp template sending error:', error.response?.data || error.message);
    throw error;
  }
};


/**
 * Send schedule notification via WhatsApp using templates
 * @param {Object} user - User object
 * @param {Object} schedule - Schedule object
 * @param {Object} location - Location object
 */
const sendScheduleWhatsApp = async (user, schedule, location) => {
  try {
    // Get WhatsApp settings to use the configured template
    const WhatsAppSettings = require('../models/WhatsAppSettings');
    const settings = await WhatsAppSettings.findOne();
    
    if (!settings || !settings.enabled) {
      throw new Error('WhatsApp integration is disabled');
    }
    
    // Get template configuration
    const template = settings.templates?.scheduleReminder;
    
    if (!template || !template.name) {
      throw new Error('Schedule reminder template not configured');
    }
    
    // Try to send using template
    const dateStr = new Date(schedule.date).toLocaleDateString();
    const parameters = {
      user_name: user.name,
      schedule_date: dateStr,
      schedule_time: `${schedule.startTime} - ${schedule.endTime}`,
      location_name: `${location.name}, ${location.address}, ${location.city}`
    };
    
    return await sendWhatsAppTemplate(user.phone, template.name, template.language, parameters);
  } catch (templateError) {
    console.error('Template message failed, falling back to text message:', templateError.message);
    
    // Fall back to regular text message if template fails
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
  }
};

/**
 * Send welcome message to a new user via WhatsApp using templates
 * @param {Object} user - User object
 * @param {string} companyName - Company name to include in the welcome message
 */
const sendWelcomeWhatsApp = async (user, companyName) => {
  try {
    // Get WhatsApp settings to use the configured template
    const WhatsAppSettings = require('../models/WhatsAppSettings');
    const settings = await WhatsAppSettings.findOne();
    
    if (!settings || !settings.enabled) {
      throw new Error('WhatsApp integration is disabled');
    }
    
    // Get template configuration
    const template = settings.templates?.welcomeMessage;
    
    if (!template || !template.name) {
      throw new Error('Welcome message template not configured');
    }
    
    // Try to send using template
    const parameters = {
      
      user_name: user.name,
      company_name: companyName || 'Our Company'
    };
    
    return await sendWhatsAppTemplate(user.phone, template.name, template.language, parameters);
  } catch (templateError) {
    console.error('Template message failed, falling back to text message:', templateError.message);
    
    // Fall back to regular text message if template fails
    const message = `
Hello ${user.name},

Welcome to ${companyName || 'Our Company'}! We are excited to have you join our team. You can use this number for schedule updates and company announcements.

Reply to this message if you have any questions.
`;
    
    return sendWhatsAppMessage(user.phone, message);
  }
};

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  sendScheduleWhatsApp,
  sendWelcomeWhatsApp
};