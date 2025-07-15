const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const AbsenceSchema = new Schema({
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
  team: {
    type: Schema.Types.ObjectId,
    ref: 'team',
    required: false
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  reason: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['sick', 'vacation', 'personal', 'other'],
    default: 'sick'
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'completed'],
    default: 'pending'
  },
  replacementNeeded: {
    type: Boolean,
    default: true
  },
  replacementAssigned: {
    type: Boolean,
    default: false
  },
  replacementUser: {
    type: Schema.Types.ObjectId,
    ref: 'user',
    required: false
  },
  notes: {
    type: String,
    required: false
  },
  approvedBy: {
    type: Schema.Types.ObjectId,
    ref: 'user',
    required: false
  },
  notificationSent: {
    type: Boolean,
    default: false
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

module.exports = Absence = mongoose.model('absence', AbsenceSchema);