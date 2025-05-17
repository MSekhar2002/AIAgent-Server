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

module.exports = User = mongoose.model('user', UserSchema);