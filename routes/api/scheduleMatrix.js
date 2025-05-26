const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const Schedule = require('../../models/Schedule');
const User = require('../../models/User');
const Absence = require('../../models/Absence');
const HourTracking = require('../../models/HourTracking');

// Helper function to get start and end dates for a week
const getWeekDates = (date, weekOffset = 0) => {
  const currentDate = new Date(date);
  currentDate.setDate(currentDate.getDate() + (weekOffset * 7));
  
  // Get the day of the week (0 = Sunday, 1 = Monday, etc.)
  const day = currentDate.getDay();
  
  // Calculate the date of the Monday of this week
  const monday = new Date(currentDate);
  monday.setDate(currentDate.getDate() - day + (day === 0 ? -6 : 1));
  monday.setHours(0, 0, 0, 0);
  
  // Calculate the date of the Sunday of this week
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  
  return { startDate: monday, endDate: sunday };
};

// @route   GET api/schedule-matrix
// @desc    Get schedule matrix for a specific week
// @access  Private/Admin
router.get('/', [auth, admin], async (req, res) => {
  try {
    const { date, weekOffset } = req.query;
    const baseDate = date ? new Date(date) : new Date();
    const offset = weekOffset ? parseInt(weekOffset) : 0;
    
    // Get start and end dates for the week
    const { startDate, endDate } = getWeekDates(baseDate, offset);
    
    // Get all schedules for the week
    const schedules = await Schedule.find({
      date: { $gte: startDate, $lte: endDate }
    })
      .populate('assignedEmployees', 'name department position')
      .populate('location', 'name address city')
      .populate('absences')
      .populate('hourTracking')
      .sort({ date: 1, startTime: 1 });
    
    // Get all users
    const users = await User.find({ role: 'employee' })
      .select('name department position')
      .sort({ department: 1, name: 1 });
    
    // Get all absences for the week
    const absences = await Absence.find({
      $or: [
        { startDate: { $lte: endDate }, endDate: { $gte: startDate } },
        { startDate: { $gte: startDate, $lte: endDate } },
        { endDate: { $gte: startDate, $lte: endDate } }
      ]
    })
      .populate('user', 'name')
      .populate('schedule', 'title date')
      .populate('replacementUser', 'name');
    
    // Create a matrix of days (columns) and users (rows)
    const days = [];
    const currentDay = new Date(startDate);
    
    // Generate array of days in the week
    while (currentDay <= endDate) {
      days.push(new Date(currentDay));
      currentDay.setDate(currentDay.getDate() + 1);
    }
    
    // Create the matrix
    const matrix = {
      startDate,
      endDate,
      days: days.map(day => day.toISOString().split('T')[0]),
      users: users.map(user => ({
        id: user._id,
        name: user.name,
        department: user.department,
        position: user.position,
        schedules: days.map(day => {
          const dayStr = day.toISOString().split('T')[0];
          const userSchedules = schedules.filter(schedule => {
            const scheduleDate = new Date(schedule.date).toISOString().split('T')[0];
            return scheduleDate === dayStr && schedule.assignedEmployees.some(emp => emp._id.toString() === user._id.toString());
          });
          
          // Check if user has an absence for this day
          const userAbsences = absences.filter(absence => {
            const absenceStart = new Date(absence.startDate).toISOString().split('T')[0];
            const absenceEnd = new Date(absence.endDate).toISOString().split('T')[0];
            return absence.user._id.toString() === user._id.toString() && 
                   dayStr >= absenceStart && dayStr <= absenceEnd;
          });
          
          return {
            date: dayStr,
            schedules: userSchedules.map(schedule => ({
              id: schedule._id,
              title: schedule.title,
              startTime: schedule.startTime,
              endTime: schedule.endTime,
              location: schedule.location ? schedule.location.name : null,
              status: schedule.status
            })),
            absences: userAbsences.map(absence => ({
              id: absence._id,
              reason: absence.reason,
              type: absence.type,
              status: absence.status,
              replacementUser: absence.replacementUser ? absence.replacementUser.name : null
            }))
          };
        })
      }))
    };
    
    res.json(matrix);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/schedule-matrix/department/:departmentId
// @desc    Get schedule matrix for a specific department
// @access  Private/Admin
router.get('/department/:department', [auth, admin], async (req, res) => {
  try {
    const { date, weekOffset } = req.query;
    const baseDate = date ? new Date(date) : new Date();
    const offset = weekOffset ? parseInt(weekOffset) : 0;
    
    // Get start and end dates for the week
    const { startDate, endDate } = getWeekDates(baseDate, offset);
    
    // Get all users in the department
    const users = await User.find({ 
      department: req.params.department,
      role: 'employee'
    })
      .select('name department position')
      .sort({ name: 1 });
    
    // Get all schedules for the week with assigned employees in the department
    const schedules = await Schedule.find({
      date: { $gte: startDate, $lte: endDate },
      assignedEmployees: { $in: users.map(user => user._id) }
    })
      .populate('assignedEmployees', 'name department position')
      .populate('location', 'name address city')
      .populate('absences')
      .populate('hourTracking')
      .sort({ date: 1, startTime: 1 });
    
    // Get all absences for the week for users in the department
    const absences = await Absence.find({
      user: { $in: users.map(user => user._id) },
      $or: [
        { startDate: { $lte: endDate }, endDate: { $gte: startDate } },
        { startDate: { $gte: startDate, $lte: endDate } },
        { endDate: { $gte: startDate, $lte: endDate } }
      ]
    })
      .populate('user', 'name')
      .populate('schedule', 'title date')
      .populate('replacementUser', 'name');
    
    // Create a matrix of days (columns) and users (rows)
    const days = [];
    const currentDay = new Date(startDate);
    
    // Generate array of days in the week
    while (currentDay <= endDate) {
      days.push(new Date(currentDay));
      currentDay.setDate(currentDay.getDate() + 1);
    }
    
    // Create the matrix
    const matrix = {
      department: req.params.department,
      startDate,
      endDate,
      days: days.map(day => day.toISOString().split('T')[0]),
      users: users.map(user => ({
        id: user._id,
        name: user.name,
        position: user.position,
        schedules: days.map(day => {
          const dayStr = day.toISOString().split('T')[0];
          const userSchedules = schedules.filter(schedule => {
            const scheduleDate = new Date(schedule.date).toISOString().split('T')[0];
            return scheduleDate === dayStr && schedule.assignedEmployees.some(emp => emp._id.toString() === user._id.toString());
          });
          
          // Check if user has an absence for this day
          const userAbsences = absences.filter(absence => {
            const absenceStart = new Date(absence.startDate).toISOString().split('T')[0];
            const absenceEnd = new Date(absence.endDate).toISOString().split('T')[0];
            return absence.user._id.toString() === user._id.toString() && 
                   dayStr >= absenceStart && dayStr <= absenceEnd;
          });
          
          return {
            date: dayStr,
            schedules: userSchedules.map(schedule => ({
              id: schedule._id,
              title: schedule.title,
              startTime: schedule.startTime,
              endTime: schedule.endTime,
              location: schedule.location ? schedule.location.name : null,
              status: schedule.status
            })),
            absences: userAbsences.map(absence => ({
              id: absence._id,
              reason: absence.reason,
              type: absence.type,
              status: absence.status,
              replacementUser: absence.replacementUser ? absence.replacementUser.name : null
            }))
          };
        })
      }))
    };
    
    res.json(matrix);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/schedule-matrix/user/:userId
// @desc    Get schedule matrix for a specific user
// @access  Private
router.get('/user/:userId', auth, async (req, res) => {
  try {
    // Check if user is requesting their own data or is an admin
    if (req.params.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(401).json({ msg: 'Not authorized' });
    }
    
    const { date, weekOffset } = req.query;
    const baseDate = date ? new Date(date) : new Date();
    const offset = weekOffset ? parseInt(weekOffset) : 0;
    
    // Get start and end dates for the week
    const { startDate, endDate } = getWeekDates(baseDate, offset);
    
    // Get user
    const user = await User.findById(req.params.userId)
      .select('name department position');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // Get all schedules for the week where user is assigned
    const schedules = await Schedule.find({
      date: { $gte: startDate, $lte: endDate },
      assignedEmployees: req.params.userId
    })
      .populate('location', 'name address city')
      .populate('absences')
      .populate('hourTracking')
      .sort({ date: 1, startTime: 1 });
    
    // Get all absences for the week for this user
    const absences = await Absence.find({
      user: req.params.userId,
      $or: [
        { startDate: { $lte: endDate }, endDate: { $gte: startDate } },
        { startDate: { $gte: startDate, $lte: endDate } },
        { endDate: { $gte: startDate, $lte: endDate } }
      ]
    })
      .populate('schedule', 'title date')
      .populate('replacementUser', 'name');
    
    // Get hour tracking records for the week
    const hourTracking = await HourTracking.find({
      user: req.params.userId,
      date: { $gte: startDate, $lte: endDate }
    }).populate('schedule', 'title');
    
    // Create a matrix of days
    const days = [];
    const currentDay = new Date(startDate);
    
    // Generate array of days in the week
    while (currentDay <= endDate) {
      days.push(new Date(currentDay));
      currentDay.setDate(currentDay.getDate() + 1);
    }
    
    // Create the user schedule matrix
    const matrix = {
      user: {
        id: user._id,
        name: user.name,
        department: user.department,
        position: user.position
      },
      startDate,
      endDate,
      days: days.map(day => {
        const dayStr = day.toISOString().split('T')[0];
        
        // Get schedules for this day
        const daySchedules = schedules.filter(schedule => {
          const scheduleDate = new Date(schedule.date).toISOString().split('T')[0];
          return scheduleDate === dayStr;
        });
        
        // Check if user has an absence for this day
        const dayAbsences = absences.filter(absence => {
          const absenceStart = new Date(absence.startDate).toISOString().split('T')[0];
          const absenceEnd = new Date(absence.endDate).toISOString().split('T')[0];
          return dayStr >= absenceStart && dayStr <= absenceEnd;
        });
        
        // Get hour tracking for this day
        const dayHourTracking = hourTracking.filter(record => {
          const recordDate = new Date(record.date).toISOString().split('T')[0];
          return recordDate === dayStr;
        });
        
        return {
          date: dayStr,
          schedules: daySchedules.map(schedule => ({
            id: schedule._id,
            title: schedule.title,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            location: schedule.location ? schedule.location.name : null,
            status: schedule.status
          })),
          absences: dayAbsences.map(absence => ({
            id: absence._id,
            reason: absence.reason,
            type: absence.type,
            status: absence.status,
            replacementUser: absence.replacementUser ? absence.replacementUser.name : null
          })),
          hourTracking: dayHourTracking.map(record => ({
            id: record._id,
            schedule: record.schedule ? record.schedule.title : null,
            clockInTime: record.clockInTime,
            clockOutTime: record.clockOutTime,
            totalHours: record.totalHours,
            status: record.status
          }))
        };
      })
    };
    
    res.json(matrix);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;