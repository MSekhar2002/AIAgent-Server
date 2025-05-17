const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const Schedule = require('../../models/Schedule');
const User = require('../../models/User');
const Location = require('../../models/Location');
const Notification = require('../../models/Notification');
const { sendScheduleNotification } = require('../../utils/emailService');
const { sendScheduleWhatsApp } = require('../../utils/whatsappService');

// @route   POST api/schedules
// @desc    Create a schedule
// @access  Private/Admin
router.post('/', [auth, admin], async (req, res) => {
  const {
    title,
    description,
    date,
    startTime,
    endTime,
    location,
    assignedEmployees,
    notificationOptions
  } = req.body;

  try {
    // Check if location exists
    const locationDoc = await Location.findById(location);
    if (!locationDoc) {
      return res.status(404).json({ msg: 'Location not found' });
    }

    // Create new schedule
    const newSchedule = new Schedule({
      title,
      description,
      date,
      startTime,
      endTime,
      location,
      assignedEmployees: assignedEmployees || [],
      notificationOptions: notificationOptions || {
        sendEmail: true,
        sendWhatsapp: true,
        reminderTime: 24
      },
      createdBy: req.user.id
    });

    // Save schedule
    const schedule = await newSchedule.save();

    // Send notifications to assigned employees
    if (assignedEmployees && assignedEmployees.length > 0) {
      const employees = await User.find({
        _id: { $in: assignedEmployees }
      });

      // Process each employee for notifications
      const notificationPromises = employees.map(async (employee) => {
        try {
          // Create notification record
          const notification = new Notification({
            type: employee.notificationPreferences.email && employee.notificationPreferences.whatsapp ? 'both' :
                  employee.notificationPreferences.email ? 'email' : 'whatsapp',
            recipient: employee._id,
            subject: `New Schedule: ${title}`,
            content: `You have been assigned to ${title} on ${new Date(date).toLocaleDateString()}`,
            relatedTo: 'schedule',
            relatedId: schedule._id,
            createdBy: req.user.id
          });

          await notification.save();

          // Send email notification
          if (employee.notificationPreferences.email) {
            await sendScheduleNotification(employee, schedule, locationDoc);
            notification.status = 'sent';
            notification.sentAt = Date.now();
            await notification.save();
          }

          // Send WhatsApp notification
          if (employee.notificationPreferences.whatsapp && employee.phone) {
            await sendScheduleWhatsApp(employee, schedule, locationDoc);
            notification.status = 'sent';
            notification.sentAt = Date.now();
            await notification.save();
          }

          return notification;
        } catch (notificationErr) {
          console.error(`Notification error for employee ${employee._id}:`, notificationErr.message);
          return null;
        }
      });

      await Promise.all(notificationPromises);

      // Update schedule with notification sent status
      schedule.notificationSent = true;
      await schedule.save();
    }

    res.json(schedule);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/schedules
// @desc    Get all schedules
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    let schedules;
    
    // If admin, get all schedules
    // If employee, get only schedules assigned to them
    const user = await User.findById(req.user.id);
    
    if (user.role === 'admin') {
      schedules = await Schedule.find()
        .populate('location', 'name address city state')
        .populate('assignedEmployees', 'name email')
        .populate('createdBy', 'name')
        .sort({ date: 1 });
    } else {
      schedules = await Schedule.find({ assignedEmployees: req.user.id })
        .populate('location', 'name address city state')
        .populate('assignedEmployees', 'name email')
        .populate('createdBy', 'name')
        .sort({ date: 1 });
    }
    
    res.json(schedules);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/schedules/upcoming
// @desc    Get upcoming schedules
// @access  Private
router.get('/upcoming', auth, async (req, res) => {
  try {
    // Get current date
    const now = new Date();
    
    // Find schedules that are upcoming (today or in the future)
    let schedules;
    
    // If admin, get all upcoming schedules
    // If employee, get only upcoming schedules assigned to them
    const user = await User.findById(req.user.id);
    
    if (user.role === 'admin') {
      schedules = await Schedule.find({
        date: { $gte: now },
        status: { $ne: 'cancelled' }
      })
        .populate('location', 'name address city state')
        .populate('assignedEmployees', 'name email')
        .populate('createdBy', 'name')
        .sort({ date: 1 })
        .limit(10); // Limit to 10 upcoming schedules
    } else {
      schedules = await Schedule.find({
        assignedEmployees: req.user.id,
        date: { $gte: now },
        status: { $ne: 'cancelled' }
      })
        .populate('location', 'name address city state')
        .populate('assignedEmployees', 'name email')
        .populate('createdBy', 'name')
        .sort({ date: 1 })
        .limit(10); // Limit to 10 upcoming schedules
    }
    
    res.json(schedules);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/schedules/:id
// @desc    Get schedule by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const schedule = await Schedule.findById(req.params.id)
      .populate('location', 'name address city state coordinates')
      .populate('assignedEmployees', 'name email phone')
      .populate('createdBy', 'name');
    
    if (!schedule) {
      return res.status(404).json({ msg: 'Schedule not found' });
    }
    
    // Check if user is admin or assigned to this schedule
    const user = await User.findById(req.user.id);
    
    if (user.role !== 'admin' && !schedule.assignedEmployees.some(emp => emp._id.toString() === req.user.id)) {
      return res.status(403).json({ msg: 'Not authorized to view this schedule' });
    }
    
    res.json(schedule);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Schedule not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/schedules/:id
// @desc    Update schedule
// @access  Private/Admin
router.put('/:id', [auth, admin], async (req, res) => {
  const {
    title,
    description,
    date,
    startTime,
    endTime,
    location,
    assignedEmployees,
    notificationOptions,
    status
  } = req.body;

  try {
    let schedule = await Schedule.findById(req.params.id);
    
    if (!schedule) {
      return res.status(404).json({ msg: 'Schedule not found' });
    }
    
    // Check if location exists if provided
    if (location) {
      const locationDoc = await Location.findById(location);
      if (!locationDoc) {
        return res.status(404).json({ msg: 'Location not found' });
      }
    }
    
    // Build schedule object
    const scheduleFields = {};
    if (title) scheduleFields.title = title;
    if (description !== undefined) scheduleFields.description = description;
    if (date) scheduleFields.date = date;
    if (startTime) scheduleFields.startTime = startTime;
    if (endTime) scheduleFields.endTime = endTime;
    if (location) scheduleFields.location = location;
    if (assignedEmployees) scheduleFields.assignedEmployees = assignedEmployees;
    if (notificationOptions) scheduleFields.notificationOptions = notificationOptions;
    if (status) scheduleFields.status = status;
    scheduleFields.updatedAt = Date.now();
    
    // Update schedule
    schedule = await Schedule.findByIdAndUpdate(
      req.params.id,
      { $set: scheduleFields },
      { new: true }
    )
      .populate('location', 'name address city state')
      .populate('assignedEmployees', 'name email')
      .populate('createdBy', 'name');
    
    // Check if employees were added and send notifications
    const oldEmployeeIds = schedule.assignedEmployees.map(emp => emp._id.toString());
    const newEmployeeIds = assignedEmployees || [];
    
    // Find newly added employees
    const addedEmployeeIds = newEmployeeIds.filter(id => !oldEmployeeIds.includes(id));
    
    if (addedEmployeeIds.length > 0) {
      const locationDoc = await Location.findById(schedule.location);
      const addedEmployees = await User.find({ _id: { $in: addedEmployeeIds } });
      
      // Send notifications to newly added employees
      const notificationPromises = addedEmployees.map(async (employee) => {
        try {
          // Create notification record
          const notification = new Notification({
            type: employee.notificationPreferences.email && employee.notificationPreferences.whatsapp ? 'both' :
                  employee.notificationPreferences.email ? 'email' : 'whatsapp',
            recipient: employee._id,
            subject: `Schedule Update: ${schedule.title}`,
            content: `You have been assigned to ${schedule.title} on ${new Date(schedule.date).toLocaleDateString()}`,
            relatedTo: 'schedule',
            relatedId: schedule._id,
            createdBy: req.user.id
          });

          await notification.save();

          // Send email notification
          if (employee.notificationPreferences.email) {
            await sendScheduleNotification(employee, schedule, locationDoc);
            notification.status = 'sent';
            notification.sentAt = Date.now();
            await notification.save();
          }

          // Send WhatsApp notification
          if (employee.notificationPreferences.whatsapp && employee.phone) {
            await sendScheduleWhatsApp(employee, schedule, locationDoc);
            notification.status = 'sent';
            notification.sentAt = Date.now();
            await notification.save();
          }

          return notification;
        } catch (notificationErr) {
          console.error(`Notification error for employee ${employee._id}:`, notificationErr.message);
          return null;
        }
      });

      await Promise.all(notificationPromises);
    }
    
    res.json(schedule);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Schedule not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   DELETE api/schedules/:id
// @desc    Delete schedule
// @access  Private/Admin
router.delete('/:id', [auth, admin], async (req, res) => {
  try {
    const schedule = await Schedule.findById(req.params.id);
    
    if (!schedule) {
      return res.status(404).json({ msg: 'Schedule not found' });
    }
    
    await Schedule.findByIdAndRemove(req.params.id);
    
    res.json({ msg: 'Schedule removed' });
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Schedule not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   GET api/schedules/employee/:id
// @desc    Get schedules for a specific employee
// @access  Private/Admin
router.get('/employee/:id', [auth, admin], async (req, res) => {
  try {
    const employee = await User.findById(req.params.id);
    
    if (!employee) {
      return res.status(404).json({ msg: 'Employee not found' });
    }
    
    const schedules = await Schedule.find({ assignedEmployees: req.params.id })
      .populate('location', 'name address city state')
      .populate('assignedEmployees', 'name email')
      .populate('createdBy', 'name')
      .sort({ date: 1 });
    
    res.json(schedules);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Employee not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   GET api/schedules/today
// @desc    Get today's schedules for the logged in user
// @access  Private
router.get('/user/today', auth, async (req, res) => {
  try {
    // Get today's date range (start of day to end of day)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Find schedules for today where user is assigned
    const schedules = await Schedule.find({
      assignedEmployees: req.user.id,
      date: { $gte: today, $lt: tomorrow }
    })
      .populate('location', 'name address city state coordinates')
      .populate('assignedEmployees', 'name email')
      .populate('createdBy', 'name')
      .sort({ startTime: 1 });
    
    res.json(schedules);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/schedules/week
// @desc    Get this week's schedules for the logged in user
// @access  Private
router.get('/user/week', auth, async (req, res) => {
  try {
    // Get this week's date range (start of week to end of week)
    const today = new Date();
    const day = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
    
    // Calculate start of week (Sunday)
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - day);
    startOfWeek.setHours(0, 0, 0, 0);
    
    // Calculate end of week (Saturday)
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);
    
    // Find schedules for this week where user is assigned
    const schedules = await Schedule.find({
      assignedEmployees: req.user.id,
      date: { $gte: startOfWeek, $lt: endOfWeek }
    })
      .populate('location', 'name address city state coordinates')
      .populate('assignedEmployees', 'name email')
      .populate('createdBy', 'name')
      .sort({ date: 1, startTime: 1 });
    
    res.json(schedules);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});



module.exports = router;