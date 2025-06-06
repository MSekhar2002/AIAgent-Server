const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const HourTracking = require('../../models/HourTracking');
const Schedule = require('../../models/Schedule');
const User = require('../../models/User');
const Location = require('../../models/Location');
const { getTrafficData } = require('../../utils/mapsService');


// @route   GET api/hour-tracking
// @desc    Get all hour tracking records (admin or authorized user)
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    // Build query based on user role
    const query = {};
    if (req.user.role !== 'admin') {
      query.user = req.user.id; // Non-admins can only see their own records
    }

    const hourTrackings = await HourTracking.find(query)
      .populate('user', 'name email')
      .populate('schedule', 'title date startTime endTime')
      .populate('location', 'name address city')
      .sort({ date: -1 });

    res.json(hourTrackings);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST api/hour-tracking/clock-in
// @desc    Clock in for a schedule
// @access  Private
router.post('/clock-in', auth, async (req, res) => {
  const { scheduleId, notes } = req.body;

  try {
    // Check if schedule exists
    const schedule = await Schedule.findById(scheduleId);
    if (!schedule) {
      return res.status(404).json({ msg: 'Schedule not found' });
    }

    // Check if user is assigned to this schedule
    if (!schedule.assignedEmployees.includes(req.user.id)) {
      return res.status(401).json({ msg: 'User not assigned to this schedule' });
    }

    // Check if user already clocked in for this schedule
    const existingRecord = await HourTracking.findOne({
      user: req.user.id,
      schedule: scheduleId,
      date: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
    });

    if (existingRecord) {
      return res.status(400).json({ msg: 'Already clocked in for this schedule' });
    }

    // Get location information
    const location = await Location.findById(schedule.location);

    // Get traffic conditions if location exists
    let trafficConditions = null;
    if (location && location.coordinates) {
      try {
        const trafficData = await getTrafficData(location.coordinates);
        trafficConditions = {
          trafficLevel: trafficData.flowSegmentData.trafficLevel,
          trafficDescription: trafficData.flowSegmentData.trafficLevelDescription || 
            ['no traffic', 'light traffic', 'moderate traffic', 'heavy traffic', 'severe congestion'][trafficData.flowSegmentData.trafficLevel],
          travelTime: trafficData.flowSegmentData.currentTravelTime
        };
      } catch (error) {
        console.error('Error getting traffic data:', error.message);
      }
    }

    // Create new hour tracking record
    const newHourTracking = new HourTracking({
      user: req.user.id,
      schedule: scheduleId,
      date: new Date(),
      clockInTime: new Date(),
      notes,
      location: schedule.location,
      trafficConditions,
      createdBy: req.user.id
    });

    const hourTracking = await newHourTracking.save();

    // Update schedule with hour tracking reference
    schedule.hourTracking.push(hourTracking._id);
    await schedule.save();

    res.json(hourTracking);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST api/hour-tracking/clock-out/:id
// @desc    Clock out for a schedule
// @access  Private
router.post('/clock-out/:id', auth, async (req, res) => {
  const { notes } = req.body;

  try {
    // Find hour tracking record
    const hourTracking = await HourTracking.findById(req.params.id);
    if (!hourTracking) {
      return res.status(404).json({ msg: 'Hour tracking record not found' });
    }

    // Check if user owns this record
    if (hourTracking.user.toString() !== req.user.id) {
      return res.status(401).json({ msg: 'User not authorized' });
    }

    // Check if already clocked out
    if (hourTracking.clockOutTime) {
      return res.status(400).json({ msg: 'Already clocked out for this schedule' });
    }

    // Update hour tracking record
    hourTracking.clockOutTime = new Date();
    hourTracking.status = 'completed';
    
    // Calculate total hours
    const clockInTime = new Date(hourTracking.clockInTime);
    const clockOutTime = new Date(hourTracking.clockOutTime);
    const diffMs = clockOutTime - clockInTime;
    const diffHrs = diffMs / (1000 * 60 * 60);
    hourTracking.totalHours = parseFloat(diffHrs.toFixed(2));

    // Add notes if provided
    if (notes) {
      hourTracking.notes = hourTracking.notes 
        ? `${hourTracking.notes}\n${notes}` 
        : notes;
    }

    await hourTracking.save();

    res.json(hourTracking);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/hour-tracking/user
// @desc    Get all hour tracking records for current user
// @access  Private
router.get('/user', auth, async (req, res) => {
  try {
    const hourTrackings = await HourTracking.find({ user: req.user.id })
      .populate('schedule', 'title date startTime endTime')
      .populate('location', 'name address city')
      .sort({ date: -1 });

    res.json(hourTrackings);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/hour-tracking/user/summary
// @desc    Get summary of hours for current user
// @access  Private
router.get('/user/summary', auth, async (req, res) => {
  try {
    // Get query parameters for date range
    const { startDate, endDate } = req.query;
    
    // Set default date range to current month if not provided
    const currentDate = new Date();
    const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
    
    const queryStartDate = startDate ? new Date(startDate) : firstDayOfMonth;
    const queryEndDate = endDate ? new Date(endDate) : lastDayOfMonth;
    
    // Find all completed hour tracking records in date range
    const hourTrackings = await HourTracking.find({
      user: req.user.id,
      status: 'completed',
      date: { $gte: queryStartDate, $lte: queryEndDate }
    });
    
    // Calculate total hours
    let totalHours = 0;
    hourTrackings.forEach(record => {
      if (record.totalHours) {
        totalHours += record.totalHours;
      }
    });
    
    // Group by day
    const dailyHours = {};
    hourTrackings.forEach(record => {
      const dateStr = record.date.toISOString().split('T')[0];
      if (!dailyHours[dateStr]) {
        dailyHours[dateStr] = 0;
      }
      if (record.totalHours) {
        dailyHours[dateStr] += record.totalHours;
      }
    });
    
    res.json({
      totalHours: parseFloat(totalHours.toFixed(2)),
      recordCount: hourTrackings.length,
      startDate: queryStartDate,
      endDate: queryEndDate,
      dailyHours
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/hour-tracking/admin/report
// @desc    Get hour tracking report for all users (admin only)
// @access  Private/Admin
router.get('/admin/report', [auth, admin], async (req, res) => {
  try {
    // Get query parameters
    const { startDate, endDate, userId, departmentId } = req.query;
    
    // Set default date range to current month if not provided
    const currentDate = new Date();
    const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
    
    const queryStartDate = startDate ? new Date(startDate) : firstDayOfMonth;
    const queryEndDate = endDate ? new Date(endDate) : lastDayOfMonth;
    
    // Build query
    const query = {
      status: 'completed',
      date: { $gte: queryStartDate, $lte: queryEndDate }
    };
    
    // Add user filter if provided
    if (userId) {
      query.user = userId;
    }
    
    // Find all completed hour tracking records matching query
    const hourTrackings = await HourTracking.find(query)
      .populate('user', 'name email department position')
      .populate('schedule', 'title date')
      .populate('location', 'name')
      .sort({ date: -1 });
    
    // Filter by department if provided
    let filteredRecords = hourTrackings;
    if (departmentId) {
      filteredRecords = hourTrackings.filter(record => 
        record.user && record.user.department === departmentId
      );
    }
    
    // Group by user
    const userHours = {};
    filteredRecords.forEach(record => {
      const userId = record.user._id.toString();
      if (!userHours[userId]) {
        userHours[userId] = {
          user: {
            _id: record.user._id,
            name: record.user.name,
            email: record.user.email,
            department: record.user.department,
            position: record.user.position
          },
          totalHours: 0,
          records: []
        };
      }
      
      if (record.totalHours) {
        userHours[userId].totalHours += record.totalHours;
        userHours[userId].records.push({
          _id: record._id,
          date: record.date,
          schedule: record.schedule,
          location: record.location,
          clockInTime: record.clockInTime,
          clockOutTime: record.clockOutTime,
          totalHours: record.totalHours
        });
      }
    });
    
    res.json({
      startDate: queryStartDate,
      endDate: queryEndDate,
      userHours: Object.values(userHours)
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;