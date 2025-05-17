const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const Schedule = require('../../models/Schedule');
const User = require('../../models/User');
const Location = require('../../models/Location');
const Notification = require('../../models/Notification');
const Conversation = require('../../models/Conversation');

// @route   GET api/dashboard/stats
// @desc    Get dashboard statistics
// @access  Private
router.get('/stats', auth, async (req, res) => {
  try {
    // Get counts of various entities
    const userCount = await User.countDocuments();
    const scheduleCount = await Schedule.countDocuments();
    const locationCount = await Location.countDocuments({ active: true });
    const notificationCount = await Notification.countDocuments();
    const whatsappMessageCount = await Conversation.aggregate([
      { $unwind: "$messages" },
      { $count: "total" }
    ]);

    // Compile statistics
    const stats = {
      users: userCount,
      schedules: scheduleCount,
      locations: locationCount,
      notifications: notificationCount,
      whatsappMessages: whatsappMessageCount[0]?.total || 0
    };

    res.json(stats);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;