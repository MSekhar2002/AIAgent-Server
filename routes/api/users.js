const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const User = require('../../models/User');
const { sendWelcomeEmail } = require('../../utils/emailService');
const { sendWhatsAppMessage } = require('../../utils/whatsappService');

// @route   POST api/users
// @desc    Register a user (Admin creates employee)
// @access  Private/Admin
router.post('/', [auth, admin], async (req, res) => {
  const { 
    name, 
    email, 
    password, 
    phone, 
    role, 
    department, 
    position, 
    notificationPreferences 
  } = req.body;

  try {
    // Check if user exists
    let user = await User.findOne({ email });

    if (user) {
      return res.status(400).json({ msg: 'User already exists' });
    }

    // Create new user
    user = new User({
      name,
      email,
      password,
      phone,
      role: role || 'employee',
      department,
      position,
      notificationPreferences: notificationPreferences || {
        email: true,
        whatsapp: phone ? true : false
      }
    });

    // Encrypt password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    // Save user
    await user.save();

    // Send welcome notifications
    try {
      // Send welcome email
      if (user.notificationPreferences.email) {
        await sendWelcomeEmail(user);
      }

      // Send WhatsApp message
      if (user.notificationPreferences.whatsapp && user.phone) {
        await sendWhatsAppMessage(
          user.phone,
          `Welcome to the Employee Scheduling System, ${user.name}! You can now receive schedule updates and query your work schedule through WhatsApp.`
        );
      }
    } catch (notificationErr) {
      console.error('Notification error:', notificationErr.message);
      // Continue even if notification fails
    }

    // Return JWT
    const payload = {
      user: {
        id: user.id,
        role: user.role
      }
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '24h' },
      (err, token) => {
        if (err) throw err;
        res.json({ token, user: { ...user._doc, password: undefined } });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST api/users/register
// @desc    Register a user (Public registration - for demo purposes)
// @access  Public
router.post('/register', async (req, res) => {
  const { name, email, password, phone } = req.body;

  try {
    // Check if user exists
    let user = await User.findOne({ email });

    if (user) {
      return res.status(400).json({ msg: 'User already exists' });
    }

    // Create new user
    user = new User({
      name,
      email,
      password,
      phone,
      role: 'employee', // Default role for public registration
      notificationPreferences: {
        email: true,
        whatsapp: phone ? true : false
      }
    });

    // Encrypt password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    // Save user
    await user.save();

    // Return JWT
    const payload = {
      user: {
        id: user.id,
        role: user.role
      }
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '24h' },
      (err, token) => {
        if (err) throw err;
        res.json({ token });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/users
// @desc    Get all users
// @access  Private/Admin
router.get('/', [auth, admin], async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/users/:id
// @desc    Get user by ID
// @access  Private/Admin
router.get('/:id', [auth, admin], async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    res.json(user);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/users/:id
// @desc    Update user
// @access  Private/Admin
router.put('/:id', [auth, admin], async (req, res) => {
  const { 
    name, 
    email, 
    phone, 
    role, 
    department, 
    position, 
    notificationPreferences,
    password
  } = req.body;

  try {
    let user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // Build user object
    const userFields = {};
    if (name) userFields.name = name;
    if (email) userFields.email = email;
    if (phone) userFields.phone = phone;
    if (role) userFields.role = role;
    if (department) userFields.department = department;
    if (position) userFields.position = position;
    if (notificationPreferences) userFields.notificationPreferences = notificationPreferences;
    userFields.updatedAt = Date.now();
    
    // Update password if provided
    if (password) {
      const salt = await bcrypt.genSalt(10);
      userFields.password = await bcrypt.hash(password, salt);
    }
    
    // Update user
    user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: userFields },
      { new: true }
    ).select('-password');
    
    res.json(user);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   DELETE api/users/:id
// @desc    Delete user
// @access  Private/Admin
router.delete('/:id', [auth, admin], async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // Check if user is trying to delete themselves
    if (user.id === req.user.id) {
      return res.status(400).json({ msg: 'Cannot delete your own account' });
    }
    
    await User.findByIdAndRemove(req.params.id);
    
    res.json({ msg: 'User removed' });
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.status(500).send('Server Error');
  }
});

module.exports = router;