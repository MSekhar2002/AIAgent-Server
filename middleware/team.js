const User = require('../models/User');
const Team = require('../models/Team');

// Middleware to check if user belongs to a team
module.exports.teamMember = async function(req, res, next) {
  try {
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    if (!user.team) {
      return res.status(403).json({ msg: 'You must be part of a team to access this resource' });
    }
    
    // Add team ID to request for later use
    req.teamId = user.team;
    next();
  } catch (err) {
    console.error('Team middleware error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
};

// Middleware to check if user is a team owner
module.exports.teamOwner = async function(req, res, next) {
  try {
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    if (!user.team) {
      return res.status(403).json({ msg: 'You must be part of a team to access this resource' });
    }
    
    const team = await Team.findById(user.team);
    
    if (!team) {
      return res.status(404).json({ msg: 'Team not found' });
    }
    
    if (team.owner.toString() !== user._id.toString()) {
      return res.status(403).json({ msg: 'You must be the team owner to access this resource' });
    }
    
    // Add team to request for later use
    req.team = team;
    next();
  } catch (err) {
    console.error('Team owner middleware error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
};