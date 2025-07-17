const axios = require('axios');

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

const sendWhatsAppMessage = async (to, message) => {
  try {
    const client = createMetaClient();
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

const sendWhatsAppTemplate = async (to, templateName, languageCode, parameters) => {
  try {
    const client = createMetaClient();
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
          language: { code: languageCode },
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

const sendScheduleWhatsApp = async (user, schedule, location) => {
  try {
    const WhatsAppSettings = require('../models/WhatsAppSettings');
    const settings = await WhatsAppSettings.findOne();

    if (!settings || !settings.enabled) {
      throw new Error('WhatsApp integration is disabled');
    }

    const template = settings.templates?.schedule_reminder;
    if (!template || !template.name) {
      throw new Error('Schedule reminder template not configured');
    }

    const dateStr = new Date(schedule.date).toLocaleDateString();
    const parameters = {
      user_name: user.name,
      schedule_date: dateStr,
      schedule_time: `${schedule.startTime} - ${schedule.endTime}`,
      location_name: `${location.name}, ${location.address}, ${location.city}`
    };

    return await sendWhatsAppTemplate(user.phone, template.name, template.language, parameters);
  } catch (templateError) {
    console.error('Template message failed, falling back to text:', templateError.message);
    const message = `Hello ${user.name},\n\nYou have a schedule:\n\nTitle: ${schedule.title}\nDate: ${new Date(schedule.date).toLocaleDateString()}\nTime: ${schedule.startTime} - ${schedule.endTime}\nLocation: ${location.name}, ${location.address}, ${location.city}\n\nReply with questions.`;
    return sendWhatsAppMessage(user.phone, message);
  }
};

const sendWelcomeWhatsApp = async (user, companyName) => {
  try {
    const WhatsAppSettings = require('../models/WhatsAppSettings');
    const settings = await WhatsAppSettings.findOne();

    if (!settings || !settings.enabled) {
      throw new Error('WhatsApp integration is disabled');
    }

    const template = settings.templates?.welcome_message;
    if (!template || !template.name) {
      throw new Error('Welcome message template not configured');
    }

    const parameters = {
      user_name: user.name,
      company_name: companyName || 'Our Company'
    };

    return await sendWhatsAppTemplate(user.phone, template.name, template.language, parameters);
  } catch (templateError) {
    console.error('Template message failed, falling back to text:', templateError.message);
    const message = `Hello ${user.name},\n\nWelcome to ${companyName || 'Our Company'}! Use this number for schedule updates and announcements.\n\nReply with questions.`;
    return sendWhatsAppMessage(user.phone, message);
  }
};

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  sendScheduleWhatsApp,
  sendWelcomeWhatsApp
};