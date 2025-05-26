const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: false
  },
  role: {
    type: String,
    enum: ['admin', 'employee'],
    default: 'employee'
  },
  department: {
    type: String,
    required: false
  },
  position: {
    type: String,
    required: false
  },
  notificationPreferences: {
    email: {
      type: Boolean,
      default: true
    },
    whatsapp: {
      type: Boolean,
      default: false
    },
    dailyBriefing: {
      type: Boolean,
      default: false
    },
    briefingTime: {
      type: String,
      default: '08:00' // 24-hour format
    }
  },
  hourTrackingEnabled: {
    type: Boolean,
    default: true
  },
  languageSettings: {
    type: Schema.Types.ObjectId,
    ref: 'languageSettings',
    required: false
  },
  defaultLocation: {
    type: Schema.Types.ObjectId,
    ref: 'location',
    required: false
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

module.exports = User = mongoose.model('user', UserSchema);