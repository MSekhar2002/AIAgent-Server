const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const HourTrackingSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'user',
    required: true
  },
  schedule: {
    type: Schema.Types.ObjectId,
    ref: 'schedule',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  clockInTime: {
    type: Date,
    required: true
  },
  clockOutTime: {
    type: Date,
    required: false
  },
  totalHours: {
    type: Number,
    required: false
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'adjusted'],
    default: 'active'
  },
  notes: {
    type: String,
    required: false
  },
  location: {
    type: Schema.Types.ObjectId,
    ref: 'location',
    required: true
  },
  trafficConditions: {
    trafficLevel: {
      type: Number,
      min: 0,
      max: 4,
      required: false
    },
    trafficDescription: {
      type: String,
      required: false
    },
    travelTime: {
      type: Number, // in minutes
      required: false
    }
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

module.exports = HourTracking = mongoose.model('hourTracking', HourTrackingSchema);