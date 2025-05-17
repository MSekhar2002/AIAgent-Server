const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ConversationSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'user',
    required: true
  },
  platform: {
    type: String,
    enum: ['whatsapp', 'voice', 'web'],
    default: 'whatsapp'
  },
  messages: [
    {
      sender: {
        type: String,
        enum: ['user', 'system'],
        required: true
      },
      content: {
        type: String,
        required: true
      },
      timestamp: {
        type: Date,
        default: Date.now
      },
      processed: {
        type: Boolean,
        default: false
      },
      originalAudio: {
        type: String, // URL to audio file for voice messages
        required: false
      }
    }
  ],
  context: {
    type: Object,
    default: {}
  },
  active: {
    type: Boolean,
    default: true
  },
  lastActivity: {
    type: Date,
    default: Date.now
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

// Set TTL index to automatically expire inactive conversations after 24 hours
ConversationSchema.index({ lastActivity: 1 }, { expireAfterSeconds: 86400 });

module.exports = Conversation = mongoose.model('conversation', ConversationSchema);