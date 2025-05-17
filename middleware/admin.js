const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async function(req, res, next) {
  try {
    // Get user from auth middleware
    const user = await User.findById(req.user.id).select('-password');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // Check if user is admin
    if (user.role !== 'admin') {
      return res.status(403).json({ msg: 'Access denied. Admin privileges required' });
    }
    
    next();
  } catch (err) {
    console.error('Admin middleware error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
};