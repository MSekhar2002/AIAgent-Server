const mongoose = require('mongoose');

const WhatsAppSettingsSchema = new mongoose.Schema({
  enabled: {
    type: Boolean,
    default: true
  },
  autoReplyEnabled: {
    type: Boolean,
    default: true
  },
  welcomeMessage: {
    type: String,
    default: 'Welcome to the Employee Scheduling System. How can I help you today?'
  },
  aiProcessingEnabled: {
    type: Boolean,
    default: true
  },
  maxResponseLength: {
    type: Number,
    default: 300
  },
  aiSystemInstructions: {
    type: String,
    default: 'You are a helpful assistant for an employee scheduling system. Provide concise and accurate information about schedules, locations, and company policies. If you don\'t know the answer, say so politely.'
  },
  // Meta WhatsApp Cloud API template configuration
  templates: {
    welcomeMessage: {
      name: {
        type: String,
        default: 'welcome_message'
      },
      language: {
        type: String,
        default: 'en'
      },
      components: {
        type: Array,
        default: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '{{user_name}}' }, // name
              { type: 'text', text: '{{company_name}}' }  // company name
            ]
          }
        ]
      }
    },
    scheduleReminder: {
      name: {
        type: String,
        default: 'schedule_reminder'
      },
      language: {
        type: String,
        default: 'en'
      },
      components: {
        type: Array,
        default: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '{{user_name}}' }, // name
              { type: 'text', text: '{{schedule_date}}' }, // date
              { type: 'text', text: '{{schedule_time}}' }, // time
              { type: 'text', text: '{{location_name}}' }  // location
            ]
          }
        ]
      }
    },
    scheduleChange: {
      name: {
        type: String,
        default: 'schedule_change'
      },
      language: {
        type: String,
        default: 'en'
      },
      components: {
        type: Array,
        default: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '{{user_name}}' }, // name
              { type: 'text', text: '{{schedule_date}}' }, // date
              { type: 'text', text: '{{schedule_time}}' }, // time
              { type: 'text', text: '{{location_name}}' }  // location
            ]
          }
        ]
      }
    },
    generalAnnouncement: {
      name: {
        type: String,
        default: 'general_announcement'
      },
      language: {
        type: String,
        default: 'en'
      },
      components: {
        type: Array,
        default: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '{{user_name}}' }, // name
              { type: 'text', text: '{{announcement_message}}' }  // message
            ]
          }
        ]
      }
    }
  },
  // Legacy template format for backward compatibility
  notificationTemplates: {
    welcomeMessage: {
      type: String,
      default: 'Hello {{name}}, welcome to {{company}}! We are excited to have you join our team. You can use this number for schedule updates and company announcements.'
    },
    scheduleReminder: {
      type: String,
      default: 'Hello {{name}}, this is a reminder about your upcoming shift on {{date}} at {{time}} at {{location}}.'
    },
    scheduleChange: {
      type: String,
      default: 'Hello {{name}}, your schedule has been updated. Your new shift is on {{date}} at {{time}} at {{location}}.'
    },
    generalAnnouncement: {
      type: String,
      default: 'Hello {{name}}, important announcement: {{message}}'
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('WhatsAppSettings', WhatsAppSettingsSchema);