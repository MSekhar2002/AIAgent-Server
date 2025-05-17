const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const Schedule = require('../../models/Schedule');
const Location = require('../../models/Location');
const { sendEmail } = require('../../utils/emailService');
const { sendWhatsAppMessage } = require('../../utils/whatsappService');
const { getTrafficData, getRouteInfo } = require('../../utils/mapsService');

// @route   POST api/notifications
// @desc    Create and send a notification
// @access  Private/Admin
router.post('/', [auth, admin], async (req, res) => {
  const {
    type,
    recipients,
    subject,
    content,
    relatedTo,
    relatedId
  } = req.body;

  try {
    // Validate recipients
    if (!recipients || recipients.length === 0) {
      return res.status(400).json({ msg: 'Recipients are required' });
    }

    // Get recipient users
    const users = await User.find({ _id: { $in: recipients } });
    
    if (users.length === 0) {
      return res.status(404).json({ msg: 'No valid recipients found' });
    }

    // Create and send notifications for each recipient
    const notificationPromises = users.map(async (user) => {
      try {
        // Create notification record
        const notification = new Notification({
          type: type || 'email',
          recipient: user._id,
          subject,
          content,
          relatedTo: relatedTo || 'other',
          relatedId,
          createdBy: req.user.id
        });

        await notification.save();

        // Send email notification
        if (type === 'email' || type === 'both') {
          if (user.notificationPreferences.email) {
            await sendEmail(user.email, subject, content);
            notification.status = 'sent';
            notification.sentAt = Date.now();
            await notification.save();
          }
        }

        // Send WhatsApp notification
        if (type === 'whatsapp' || type === 'both') {
          if (user.notificationPreferences.whatsapp && user.phone) {
            await sendWhatsAppMessage(user.phone, content);
            notification.status = 'sent';
            notification.sentAt = Date.now();
            await notification.save();
          }
        }

        return notification;
      } catch (notificationErr) {
        console.error(`Notification error for user ${user._id}:`, notificationErr.message);
        return null;
      }
    });

    const notifications = await Promise.all(notificationPromises);
    const validNotifications = notifications.filter(n => n !== null);

    res.json(validNotifications);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/notifications
// @desc    Get all notifications for the authenticated user
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const notifications = await Notification.find({ recipient: req.user.id })
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 });
    
    res.json(notifications);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/notifications/admin
// @desc    Get all notifications (admin view)
// @access  Private/Admin
router.get('/admin', [auth, admin], async (req, res) => {
  try {
    const notifications = await Notification.find()
      .populate('recipient', 'name email')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 });
    
    res.json(notifications);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST api/notifications/traffic-alerts
// @desc    Send traffic alerts to users with upcoming schedules
// @access  Private/Admin
router.get('/traffic-alerts', [auth, admin], async (req, res) => {
  try {
    // Get schedules for today and tomorrow
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dayAfterTomorrow = new Date(today);
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
    
    // Find all upcoming schedules with locations
    const schedules = await Schedule.find({
      date: { $gte: today, $lt: dayAfterTomorrow }
    })
      .populate('assignedEmployees', 'name email phone notificationPreferences')
      .populate('location');
    
    if (schedules.length === 0) {
      return res.status(404).json({ msg: 'No upcoming schedules found' });
    }
    
    // Process each schedule and send traffic alerts
    const notificationPromises = [];
    
    for (const schedule of schedules) {
      // Skip schedules without locations or employees
      if (!schedule.location || !schedule.assignedEmployees || schedule.assignedEmployees.length === 0) {
        continue;
      }
      
      // Get traffic data for the location
      let trafficData;
      try {
        trafficData = await getTrafficData(schedule.location.coordinates);
      } catch (trafficErr) {
        console.error(`Traffic data error for location ${schedule.location._id}:`, trafficErr.message);
        continue;
      }
      
      // Only send alerts if traffic is moderate to heavy (level 2 or higher)
      const trafficLevel = trafficData.flowSegmentData.trafficLevel;
      if (trafficLevel < 2) {
        continue;
      }
      
      const trafficDescription = trafficData.flowSegmentData.trafficLevelDescription || 
        ['No data', 'Free flow', 'Sluggish', 'Heavy', 'Congested', 'Blocked'][trafficLevel];
      
      // Create notification for each assigned employee
      for (const employee of schedule.assignedEmployees) {
        // Skip employees who have disabled notifications
        if (!employee.notificationPreferences) {
          continue;
        }
        
        // Create notification content
        const subject = `Traffic Alert: ${schedule.title} on ${new Date(schedule.date).toLocaleDateString()}`;
        const content = `
Hello ${employee.name},

Traffic Alert for your upcoming schedule:

Title: ${schedule.title}
Date: ${new Date(schedule.date).toLocaleDateString()}
Time: ${schedule.startTime} - ${schedule.endTime}
Location: ${schedule.location.name}, ${schedule.location.address}, ${schedule.location.city}

Current Traffic Conditions: ${trafficDescription}

Please allow extra time for your commute. For detailed route options, send "route options" via WhatsApp or check the app.
`;
        
        // Create notification record
        const notification = new Notification({
          type: employee.notificationPreferences.whatsapp && employee.phone ? 'both' : 'email',
          recipient: employee._id,
          subject,
          content,
          relatedTo: 'traffic',
          relatedId: schedule._id,
          createdBy: req.user.id
        });
        
        await notification.save();
        
        // Send email notification
        if (employee.notificationPreferences.email) {
          try {
            await sendEmail(employee.email, subject, content);
            notification.status = 'sent';
            notification.sentAt = Date.now();
            await notification.save();
          } catch (emailErr) {
            console.error(`Email error for user ${employee._id}:`, emailErr.message);
          }
        }
        
        // Send WhatsApp notification
        if (employee.notificationPreferences.whatsapp && employee.phone) {
          try {
            await sendWhatsAppMessage(employee.phone, content);
            notification.status = 'sent';
            notification.sentAt = Date.now();
            await notification.save();
          } catch (whatsappErr) {
            console.error(`WhatsApp error for user ${employee._id}:`, whatsappErr.message);
          }
        }
        
        notificationPromises.push(notification);
      }
    }
    
    const notifications = await Promise.all(notificationPromises);
    res.json(notifications);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/notifications/:id
// @desc    Get notification by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id)
      .populate('recipient', 'name email')
      .populate('createdBy', 'name');
    
    if (!notification) {
      return res.status(404).json({ msg: 'Notification not found' });
    }
    
    // Check if user is admin or the recipient
    const user = await User.findById(req.user.id);
    
    if (user.role !== 'admin' && notification.recipient._id.toString() !== req.user.id) {
      return res.status(403).json({ msg: 'Not authorized to view this notification' });
    }
    
    // Mark as read if not already
    if (notification.status !== 'read') {
      notification.status = 'read';
      notification.readAt = Date.now();
      await notification.save();
    }
    
    res.json(notification);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Notification not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/notifications/:id/read
// @desc    Mark notification as read
// @access  Private
router.put('/:id/read', auth, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    
    if (!notification) {
      return res.status(404).json({ msg: 'Notification not found' });
    }
    
    // Check if user is the recipient
    if (notification.recipient.toString() !== req.user.id) {
      return res.status(403).json({ msg: 'Not authorized to update this notification' });
    }
    
    // Mark as read
    notification.status = 'read';
    notification.readAt = Date.now();
    await notification.save();
    
    res.json(notification);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Notification not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   DELETE api/notifications/:id
// @desc    Delete notification
// @access  Private
router.delete('/:id', auth, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    
    if (!notification) {
      return res.status(404).json({ msg: 'Notification not found' });
    }
    
    // Check if user is admin or the recipient
    const user = await User.findById(req.user.id);
    
    if (user.role !== 'admin' && notification.recipient.toString() !== req.user.id) {
      return res.status(403).json({ msg: 'Not authorized to delete this notification' });
    }
    
    await Notification.findByIdAndRemove(req.params.id);
    
    res.json({ msg: 'Notification removed' });
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Notification not found' });
    }
    res.status(500).send('Server Error');
  }
});

module.exports = router;