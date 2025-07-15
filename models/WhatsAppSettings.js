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
    welcome_message: {
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
    schedule_reminder: {
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
    schedule_change: {
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
    general_announcement_update: {
      name: {
        type: String,
        default: 'general_announcement_update'
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
  // Template SIDs for WhatsApp Cloud API
  templateIds: {
    // English templates
    welcome_message: {
      type: String,
      default: 'HXb755e6658fd7073933a147d1846d821a'
    },
    schedule_reminder: {
      type: String,
      default: 'HX686cc768ae4fbf59aca46a2f4c56c194'
    },
    schedule_change: {
      type: String,
      default: 'HX9e4f70ee164231931aa0954ba8ac55c8'
    },
    general_announcement_update: {
      type: String,
      default: 'HX25b0a8e7b49576bd4410e3545454cae1'
    },
    // French templates
    welcome_message_fr: {
      type: String,
      default: 'HX2f3d842d478d6d04f7062ecff9ac36f0'
    },
    schedule_reminder_fr: {
      type: String,
      default: 'HX36265ebee75206f8c866ad24461f31ad'
    },
    schedule_change_fr: {
      type: String,
      default: 'HXc1110c0326a580e7c8fbe9393df534e2'
    },
    general_announcement_update_fr: {
      type: String,
      default: 'HX54b05ae203f5a608345586fee1d22bb4'
    }
  },
  // Legacy template format for backward compatibility
  notificationTemplates: {
    welcome_message: {
      type: String,
      default: 'Hello {{name}}, welcome to {{company}}! We are excited to have you join our team. You can use this number for schedule updates and company announcements.'
    },
    schedule_reminder: {
      type: String,
      default: 'Hello {{name}}, this is a reminder about your upcoming shift on {{date}} at {{time}} at {{location}}.'
    },
    schedule_change: {
      type: String,
      default: 'Hello {{name}}, your schedule has been updated. Your new shift is on {{date}} at {{time}} at {{location}}.'
    },
    general_announcement_update: {
      type: String,
      default: 'Hello {{1}}, important announcement: {{2}}'
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