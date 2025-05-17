const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const NotificationSchema = new Schema({
  type: {
    type: String,
    enum: ['email', 'whatsapp', 'both'],
    required: true
  },
  recipient: {
    type: Schema.Types.ObjectId,
    ref: 'user',
    required: true
  },
  subject: {
    type: String,
    required: true
  },
  content: {
    type: String,
    required: true
  },
  relatedTo: {
    type: String,
    enum: ['schedule', 'announcement', 'traffic', 'other'],
    default: 'other'
  },
  relatedId: {
    type: Schema.Types.ObjectId,
    required: false
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'failed', 'delivered', 'read'],
    default: 'pending'
  },
  sentAt: {
    type: Date,
    default: null
  },
  deliveredAt: {
    type: Date,
    default: null
  },
  readAt: {
    type: Date,
    default: null
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'user',
    required: true
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

module.exports = Notification = mongoose.model('notification', NotificationSchema);