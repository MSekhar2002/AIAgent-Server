const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const { teamMember, teamOwner } = require('../../middleware/team');
const Team = require('../../models/Team');
const User = require('../../models/User');

// @route   POST api/teams
// @desc    Create a team
// @access  Private
router.post('/', auth, async (req, res) => {
  const { name, description, departments } = req.body;

  try {
    // Check if user already has a team
    const user = await User.findById(req.user.id);
    
    if (user.team) {
      return res.status(400).json({ msg: 'You already belong to a team' });
    }

    // Create new team
    const newTeam = new Team({
      name,
      description,
      owner: req.user.id,
      departments: departments || []
    });

    // Save team
    const team = await newTeam.save();

    // Update user with team reference and set as team admin
    user.team = team._id;
    user.isTeamAdmin = true;
    user.role= "admin" ;
    await user.save();

    res.json(team);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/teams/my-team
// @desc    Get user's team
// @access  Private
router.get('/my-team', [auth, teamMember], async (req, res) => {
  try {
    const team = await Team.findById(req.teamId)
      .populate('owner', 'name email');
    
    if (!team) {
      return res.status(404).json({ msg: 'Team not found' });
    }
    
    res.json(team);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/teams
// @desc    Update team
// @access  Private/Team Owner
router.put('/', [auth, teamOwner], async (req, res) => {
  const { name, description, departments } = req.body;

  try {
    const team = req.team;
    
    // Update fields
    if (name) team.name = name;
    if (description !== undefined) team.description = description;
    if (departments) team.departments = departments;
    
    team.updatedAt = Date.now();
    
    await team.save();
    
    res.json(team);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST api/teams/join
// @desc    Join a team with join code
// @access  Private
router.post('/join', auth, async (req, res) => {
  const { joinCode } = req.body;

  try {
    // Check if user already has a team
    const user = await User.findById(req.user.id);
    
    if (user.team) {
      return res.status(400).json({ msg: 'You already belong to a team' });
    }

    // Find team by join code
    const team = await Team.findOne({ joinCode });
    
    if (!team) {
      return res.status(404).json({ msg: 'Invalid join code' });
    }

    // Update user with team reference
    user.team = team._id;
    await user.save();

    res.json({ msg: 'Successfully joined team', team });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/teams/members
// @desc    Get team members
// @access  Private/Team Member
router.get('/members', [auth, teamMember], async (req, res) => {
  try {
    const members = await User.find({ team: req.teamId })
      .select('-password')
      .sort({ name: 1 });
    
    res.json(members);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   DELETE api/teams/members/:id
// @desc    Remove a member from team
// @access  Private/Team Owner
router.delete('/members/:id', [auth, teamOwner], async (req, res) => {
  try {
    // Cannot remove yourself (the owner)
    if (req.params.id === req.user.id) {
      return res.status(400).json({ msg: 'Team owner cannot be removed. Transfer ownership first or delete the team.' });
    }
    
    const member = await User.findById(req.params.id);
    
    if (!member) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    if (member.team.toString() !== req.team._id.toString()) {
      return res.status(400).json({ msg: 'User is not a member of your team' });
    }
    
    // Remove team reference
    member.team = null;
    await member.save();
    
    res.json({ msg: 'Member removed from team' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST api/teams/departments
// @desc    Add department to team
// @access  Private/Team Owner
router.post('/departments', [auth, teamOwner], async (req, res) => {
  const { department } = req.body;

  try {
    const team = req.team;
    
    // Check if department already exists
    if (team.departments.includes(department)) {
      return res.status(400).json({ msg: 'Department already exists' });
    }
    
    // Add department
    team.departments.push(department);
    team.updatedAt = Date.now();
    
    await team.save();
    
    res.json(team);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   DELETE api/teams/departments/:department
// @desc    Remove department from team
// @access  Private/Team Owner
router.delete('/departments/:department', [auth, teamOwner], async (req, res) => {
  try {
    const team = req.team;
    const departmentToRemove = req.params.department;
    
    // Remove department
    team.departments = team.departments.filter(dept => dept !== departmentToRemove);
    team.updatedAt = Date.now();
    
    await team.save();
    
    res.json(team);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   DELETE api/teams
// @desc    Delete team
// @access  Private/Team Owner
router.delete('/', [auth, teamOwner], async (req, res) => {
  try {
    // Remove team reference from all members
    await User.updateMany(
      { team: req.team._id },
      { $set: { team: null } }
    );
    
    // Delete team
    await Team.findByIdAndDelete(req.team._id);
    
    res.json({ msg: 'Team deleted successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/teams/admins/:id
// @desc    Promote user to team admin
// @access  Private/Team Owner
router.put('/admins/:id', [auth, teamOwner], async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Check if user exists and is part of the team
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    if (user.team.toString() !== req.team._id.toString()) {
      return res.status(400).json({ msg: 'User is not a member of your team' });
    }
    
    // Update user to admin status
    user.isTeamAdmin = true;
    await user.save();
    
    res.json({ msg: 'User promoted to admin successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   DELETE api/teams/admins/:id
// @desc    Demote user from team admin
// @access  Private/Team Owner
router.delete('/admins/:id', [auth, teamOwner], async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Check if user exists and is part of the team
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    if (user.team.toString() !== req.team._id.toString()) {
      return res.status(400).json({ msg: 'User is not a member of your team' });
    }
    
    // Update user to remove admin status
    user.isTeamAdmin = false;
    await user.save();
    
    res.json({ msg: 'User demoted from admin successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;