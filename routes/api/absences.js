const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const Absence = require('../../models/Absence');
const Schedule = require('../../models/Schedule');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const { sendEmail } = require('../../utils/emailService');
const { sendWhatsAppMessage, sendWhatsAppTemplate } = require('../../utils/whatsappService');

// @route   POST api/absences
// @desc    Report an absence
// @access  Private
router.post('/', auth, async (req, res) => {
  const {
    scheduleId,
    startDate,
    endDate,
    reason,
    type,
    replacementNeeded,
    notes
  } = req.body;

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

    // Get user to get team
    const user = await User.findById(req.user.id);

    // Create new absence record
    const newAbsence = new Absence({
      user: req.user.id,
      schedule: scheduleId,
      team: user.team, // Add team from user
      startDate,
      endDate,
      reason,
      type: type || 'sick',
      replacementNeeded: replacementNeeded !== undefined ? replacementNeeded : true,
      notes
    });

    const absence = await newAbsence.save();

    // Update schedule with absence reference
    schedule.absences.push(absence._id);
    await schedule.save();

    // Notify admin about the absence
    const admins = await User.find({ role: 'admin' });
    // const user = await User.findById(req.user.id);

    // Create notifications for admins
    for (const admin of admins) {
      const notification = new Notification({
        type: admin.notificationPreferences.email && admin.notificationPreferences.whatsapp ? 'both' :
              admin.notificationPreferences.email ? 'email' : 'whatsapp',
        recipient: admin._id,
        subject: `Absence Report: ${user.name}`,
        content: `${user.name} has reported an absence for ${schedule.title} on ${new Date(startDate).toLocaleDateString()}. Reason: ${reason}`,
        relatedTo: 'absence',
        relatedId: absence._id,
        createdBy: req.user.id
      });

      await notification.save();

      // Send email notification
      if (admin.notificationPreferences.email) {
        await sendEmail(
          admin.email,
          `Absence Report: ${user.name}`,
          `${user.name} has reported an absence for ${schedule.title} on ${new Date(startDate).toLocaleDateString()}. Reason: ${reason}`
        );
        notification.status = 'sent';
        notification.sentAt = Date.now();
        await notification.save();
      }

      // Send WhatsApp notification
      if (admin.notificationPreferences.whatsapp && admin.phone) {
        await sendWhatsAppMessage(
          admin.phone,
          `Absence Report: ${user.name} has reported an absence for ${schedule.title} on ${new Date(startDate).toLocaleDateString()}. Reason: ${reason}`
        );
        notification.status = 'sent';
        notification.sentAt = Date.now();
        await notification.save();
      }
    }

    // If replacement is needed and auto-replacement is allowed, find potential replacements
    if (replacementNeeded && schedule.allowAutoReplacement) {
      // Find employees in the same department who are not already assigned to this schedule
      const potentialReplacements = await User.find({
        _id: { $nin: schedule.assignedEmployees },
        department: user.department,
        role: 'employee'
      });

      // Notify potential replacements
      for (const replacement of potentialReplacements) {
        const notification = new Notification({
          type: replacement.notificationPreferences.email && replacement.notificationPreferences.whatsapp ? 'both' :
                replacement.notificationPreferences.email ? 'email' : 'whatsapp',
          recipient: replacement._id,
          subject: `Replacement Opportunity`,
          content: `A replacement is needed for ${schedule.title} on ${new Date(startDate).toLocaleDateString()}. Please contact your administrator if you can cover this schedule.`,
          relatedTo: 'absence',
          relatedId: absence._id,
          createdBy: req.user.id
        });

        await notification.save();

        // Send email notification
        if (replacement.notificationPreferences.email) {
          await sendEmail(
            replacement.email,
            `Replacement Opportunity`,
            `A replacement is needed for ${schedule.title} on ${new Date(startDate).toLocaleDateString()}. Please contact your administrator if you can cover this schedule.`
          );
          notification.status = 'sent';
          notification.sentAt = Date.now();
          await notification.save();
        }

        // Send WhatsApp notification
        if (replacement.notificationPreferences.whatsapp && replacement.phone) {
          await sendWhatsAppMessage(
            replacement.phone,
            `Replacement Opportunity: A replacement is needed for ${schedule.title} on ${new Date(startDate).toLocaleDateString()}. Please contact your administrator if you can cover this schedule.`
          );
          notification.status = 'sent';
          notification.sentAt = Date.now();
          await notification.save();
        }
      }
    }

    res.json(absence);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/absences/:id
// @desc    Update absence status (admin only)
// @access  Private/Admin
router.put('/:id', [auth, admin], async (req, res) => {
  const { status, replacementUser, notes } = req.body;

  try {
    // Find absence record
    const absence = await Absence.findById(req.params.id);
    if (!absence) {
      return res.status(404).json({ msg: 'Absence record not found' });
    }

    // Update absence record
    if (status) absence.status = status;
    if (notes) absence.notes = notes;

    // Handle replacement assignment
    if (replacementUser) {
      // Check if replacement user exists
      const replacement = await User.findById(replacementUser);
      if (!replacement) {
        return res.status(404).json({ msg: 'Replacement user not found' });
      }

      absence.replacementUser = replacementUser;
      absence.replacementAssigned = true;

      // Update schedule with new assigned employee
      const schedule = await Schedule.findById(absence.schedule);
      if (schedule && !schedule.assignedEmployees.includes(replacementUser)) {
        schedule.assignedEmployees.push(replacementUser);
        await schedule.save();
      }

      // Notify replacement user
      const notification = new Notification({
        type: replacement.notificationPreferences.email && replacement.notificationPreferences.whatsapp ? 'both' :
              replacement.notificationPreferences.email ? 'email' : 'whatsapp',
        recipient: replacement._id,
        subject: `Schedule Assignment`,
        content: `You have been assigned as a replacement for a schedule: ${schedule.title} on ${new Date(schedule.date).toLocaleDateString()}.`,
        relatedTo: 'schedule',
        relatedId: schedule._id,
        createdBy: req.user.id
      });

      await notification.save();

      // Send notifications
      if (replacement.notificationPreferences.email) {
        await sendEmail(
          replacement.email,
          `Schedule Assignment`,
          `You have been assigned as a replacement for a schedule: ${schedule.title} on ${new Date(schedule.date).toLocaleDateString()}.`
        );
        notification.status = 'sent';
        notification.sentAt = Date.now();
        await notification.save();
      }

      if (replacement.notificationPreferences.whatsapp && replacement.phone) {
        await sendWhatsAppMessage(
          replacement.phone,
          `Schedule Assignment: You have been assigned as a replacement for a schedule: ${schedule.title} on ${new Date(schedule.date).toLocaleDateString()}.`
        );
        notification.status = 'sent';
        notification.sentAt = Date.now();
        await notification.save();
      }
    }

    absence.updatedAt = Date.now();
    await absence.save();

    // Notify the user who reported the absence about the status update
    const user = await User.findById(absence.user);
    const schedule = await Schedule.findById(absence.schedule);

    if (user) {
      const notification = new Notification({
        type: user.notificationPreferences.email && user.notificationPreferences.whatsapp ? 'both' :
              user.notificationPreferences.email ? 'email' : 'whatsapp',
        recipient: user._id,
        subject: `Absence Update`,
        content: `Your absence report for ${schedule.title} on ${new Date(absence.startDate).toLocaleDateString()} has been ${status.toLowerCase()}.`,
        relatedTo: 'absence',
        relatedId: absence._id,
        createdBy: req.user.id
      });

      await notification.save();

      // Send notifications
      if (user.notificationPreferences.email) {
        await sendEmail(
          user.email,
          `Absence Update`,
          `Your absence report for ${schedule.title} on ${new Date(absence.startDate).toLocaleDateString()} has been ${status.toLowerCase()}.`
        );
        notification.status = 'sent';
        notification.sentAt = Date.now();
        await notification.save();
      }

      if (user.notificationPreferences.whatsapp && user.phone) {
        await sendWhatsAppMessage(
          user.phone,
          `Absence Update: Your absence report for ${schedule.title} on ${new Date(absence.startDate).toLocaleDateString()} has been ${status.toLowerCase()}.`
        );
        notification.status = 'sent';
        notification.sentAt = Date.now();
        await notification.save();
      }
    }

    res.json(absence);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/absences/user
// @desc    Get all absences for current user
// @access  Private
router.get('/user', auth, async (req, res) => {
  try {
    const absences = await Absence.find({ user: req.user.id })
      .populate('schedule', 'title date startTime endTime')
      .populate('replacementUser', 'name email')
      .sort({ createdAt: -1 });

    res.json(absences);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/absences
// @desc    Get all absences (admin only)
// @access  Private/Admin
router.get('/', [auth, admin], async (req, res) => {
  try {
    // Get user with team info
    const user = await User.findById(req.user.id);
    
    let query = {};
    
    // If user has a team, filter absences by team
    if (user.team) {
      query = { team: user.team };
    }
    
    const absences = await Absence.find(query)
      .populate('user', 'name email')
      .populate('schedule', 'title date startTime endTime')
      .populate('replacementUser', 'name email')
      .sort({ createdAt: -1 });
    
    res.json(absences);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/absences/pending
// @desc    Get all pending absences (admin only)
// @access  Private/Admin
router.get('/pending', [auth, admin], async (req, res) => {
  try {
    const pendingAbsences = await Absence.find({ status: 'pending' })
      .populate('user', 'name email department position')
      .populate('schedule', 'title date startTime endTime')
      .populate('replacementUser', 'name email')
      .sort({ createdAt: -1 });

    res.json(pendingAbsences);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/absences/:id
// @desc    Get absence by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const absence = await Absence.findById(req.params.id)
      .populate('user', 'name email department position')
      .populate('schedule', 'title date startTime endTime location')
      .populate('replacementUser', 'name email')
      .populate({
        path: 'schedule',
        populate: {
          path: 'location',
          select: 'name address city'
        }
      });

    if (!absence) {
      return res.status(404).json({ msg: 'Absence record not found' });
    }

    // Check if user is authorized to view this absence
    if (absence.user._id.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(401).json({ msg: 'User not authorized' });
    }

    res.json(absence);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;