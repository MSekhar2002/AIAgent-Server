const twilio = require('twilio');
const winston = require('winston');

// Logger setup
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/twilio.log' }),
    new winston.transports.Console()
  ]
});

const createTwilioClient = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !phoneNumber) {
    throw new Error('Twilio credentials not configured');
  }

  return {
    client: twilio(accountSid, authToken),
    phoneNumber
  };
};

const sendWhatsAppMessage = async (to, message) => {
  try {
    const { client, phoneNumber } = createTwilioClient();
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    
    const response = await client.messages.create({
      body: message,
      from: `whatsapp:${phoneNumber}`,
      to: formattedTo
    });

    logger.info('WhatsApp message sent:', { messageId: response.sid });
    return response;
  } catch (error) {
    logger.error('WhatsApp sending error:', error.message);
    throw error;
  }
};

const sendWhatsAppTemplate = async (to, templateName, languageCode, parameters) => {
  try {
    const { client, phoneNumber } = createTwilioClient();
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:+${to}`;
    
    // Convert parameters to Twilio format
    let content = '';
    
    // Get template content from WhatsAppSettings
    const WhatsAppSettings = require('../models/WhatsAppSettings');
    const settings = await WhatsAppSettings.findOne();
    
    if (!settings || !settings.templates) {
      throw new Error('WhatsApp templates not configured');
    }
    
    // Find the template
    const template = settings.templates[templateName];
    if (!template) {
      throw new Error(`Template ${templateName} not found`);
    }
    
    // Get the template content from notificationTemplates (legacy format)
    // This is used as a fallback and for Twilio which doesn't support Meta's template structure
    content = settings.notificationTemplates[templateName] || '';
    
    // Replace parameters in the template
    if (parameters) {
      Object.entries(parameters).forEach(([key, value]) => {
        content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
      });
    }
    
    const response = await client.messages.create({
      body: content,
      from: `whatsapp:${phoneNumber}`,
      to: formattedTo
    });

    logger.info('WhatsApp template message sent:', { messageId: response.sid, template: templateName });
    return response;
  } catch (error) {
    logger.error('WhatsApp template sending error:', error.message);
    throw error;
  }
};

// New function for outside session templates
const sendWhatsAppOutsideSessionTemplate = async (to, templateName, templateData, responseLanguage = null) => {
  try {
    const { client, phoneNumber } = createTwilioClient();
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:+${to}`;
    
    // Get the correct template SID based on language
    const templateSid = await getTemplateSid(templateName, responseLanguage);
    
    // Convert templateData to Twilio's ContentVariables format
    const contentVariables = Object.entries(templateData).reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
    const abc = JSON.stringify(contentVariables);
    const templateCheck = await client.content.v1.contents(templateSid).fetch();
  console.log('Template found:', templateCheck.friendlyName);
  console.log('Template language:', templateCheck.language);
    
    const response = await client.messages.create({
      from: `whatsapp:${phoneNumber}`,
      to: formattedTo,
      contentSid: templateSid, // Use actual template SID
      contentVariables: JSON.stringify(contentVariables)
    });

    logger.info('WhatsApp outside session template sent:', { 
      messageId: response.sid, 
      template: templateName, 
      templateSid,
      language: responseLanguage 
    });
    return response;
  } catch (error) {
    logger.error('WhatsApp outside session template error:', error.message);
    throw error;
  }
};

// Update all template functions to accept responseLanguage parameter
const sendScheduleWhatsApp = async (user, schedule, location, isOutsideSession = true, responseLanguage = null) => {
  try {
    const templateData = {
      '1': user.name,
      '2': schedule.title,
      '3': new Date(schedule.date).toLocaleDateString(),
      '4': schedule.startTimeString || 'TBD',
      '5': location?.name || 'TBD'
    };
    
    await sendWhatsAppOutsideSessionTemplate(
      user.phone,
      'schedule_reminder',
      templateData,
      responseLanguage
    );
    
    logger.info('Schedule WhatsApp message sent', { userId: user._id, phone: user.phone });
  } catch (error) {
    logger.error('Error sending schedule WhatsApp message:', error);
  }
};

const sendWelcomeWhatsApp = async (user, systemName, isOutsideSession = true, responseLanguage = null) => {
  try {
    const templateData = {
      '1': user.name,
      '2': systemName,
      '3': 'www.oscowl.in',
      '4': 'Oscowl AI'
    };
    
    await sendWhatsAppOutsideSessionTemplate(
      user.phone,
      'welcome_message',
      templateData,
      responseLanguage
    );
    
    logger.info('Welcome WhatsApp message sent', { userId: user._id, phone: user.phone });
  } catch (error) {
    logger.error('Error sending welcome WhatsApp message:', error);
  }
};

const sendScheduleChangeWhatsApp = async (user, schedule, location, isOutsideSession = true, responseLanguage = null) => {
  try {
    const templateData = {
      '1': user.name,
      '2': schedule.title,
      '3': new Date(schedule.date).toLocaleDateString(),
      '4': schedule.startTimeString || 'TBD',
      '5': location?.name || 'TBD'
    };
    
    await sendWhatsAppOutsideSessionTemplate(
      user.phone,
      'schedule_change',
      templateData,
      responseLanguage
    );
    
    logger.info('Schedule change WhatsApp message sent', { userId: user._id, phone: user.phone });
  } catch (error) {
    logger.error('Error sending schedule change WhatsApp message:', error);
  }
};

const sendAnnouncementWhatsApp = async (user, message, isOutsideSession = true, responseLanguage = null) => {
  try {
    const templateData = {
      '1': user.name,
      '2': message,
      '3': 'www.oscowl.in',
      '4': 'Oscowl AI'
    };
    
    await sendWhatsAppOutsideSessionTemplate(
      user.phone,
      'general_announcement_update',
      templateData,
      responseLanguage
    );
    
    logger.info('Announcement WhatsApp message sent', { userId: user._id, phone: user.phone });
  } catch (error) {
    logger.error('Error sending announcement WhatsApp message:', error);
  }
};

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  sendWhatsAppOutsideSessionTemplate,
  sendScheduleWhatsApp,
  sendWelcomeWhatsApp,
  sendScheduleChangeWhatsApp,
  sendAnnouncementWhatsApp
};

// Updated function to detect language and select template
const getTemplateSid = async (baseTemplateName, responseLanguage) => {
  const WhatsAppSettings = require('../models/WhatsAppSettings');
  const settings = await WhatsAppSettings.findOne();
  
  if (!settings || !settings.templateIds) {
    throw new Error('WhatsApp template settings not configured');
  }
  
  // Detect if response is in French
  const isFrench = responseLanguage && (
    responseLanguage.toLowerCase().includes('french') ||
    responseLanguage.toLowerCase().includes('français') ||
    responseLanguage.toLowerCase().includes('fr')
  );
  
  const templateKey = isFrench ? `${baseTemplateName}_fr` : baseTemplateName;
  const templateSid = settings.templateIds[templateKey];
  
  if (!templateSid) {
    logger.warn(`Template SID not found for ${templateKey}, falling back to English`);
    return settings.templateIds[baseTemplateName];
  }
  const { client } = createTwilioClient();
  const templateCheck = await client.content.v1.contents(templateSid).fetch();
console.log('Template status:', templateCheck);

  
  return templateSid;
};