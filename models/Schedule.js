const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ScheduleSchema = new Schema({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: false
  },
  date: {
    type: Date,
    required: true
  },
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  location: {
    type: Schema.Types.ObjectId,
    ref: 'location',
    required: true
  },
  assignedEmployees: [{
    type: Schema.Types.ObjectId,
    ref: 'user'
  }],
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'user',
    required: true
  },
  notificationSent: {
    type: Boolean,
    default: false
  },
  notificationOptions: {
    sendEmail: {
      type: Boolean,
      default: true
    },
    sendWhatsapp: {
      type: Boolean,
      default: false
    },
    reminderTime: {
      type: Number, // hours before schedule
      default: 24
    }
  },
  status: {
    type: String,
    enum: ['scheduled', 'in-progress', 'completed', 'cancelled'],
    default: 'scheduled'
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

module.exports = Schedule = mongoose.model('schedule', ScheduleSchema);