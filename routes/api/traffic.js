const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const User = require('../../models/User');
const Schedule = require('../../models/Schedule');
const Location = require('../../models/Location');
const { getTrafficData, getRouteInformation } = require('../../utils/mapsService');

// @route   GET api/traffic/commute
// @desc    Get traffic information for user's commute to scheduled locations
// @access  Private
router.get('/commute', auth, async (req, res) => {
  try {
    // Get user with populated default location
    const user = await User.findById(req.user.id).populate('defaultLocation');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // Check if user has a default location set
    if (!user.defaultLocation) {
      return res.status(400).json({ 
        msg: 'Default location not set. Please set your default location to get traffic information.',
        needsDefaultLocation: true
      });
    }
    
    // Get today's date at midnight
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get tomorrow's date at midnight
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Get user's schedules for today
    const schedules = await Schedule.find({
      assignedEmployees: req.user.id,
      date: {
        $gte: today,
        $lt: tomorrow
      }
    }).populate('location');
    
    if (schedules.length === 0) {
      return res.json({ 
        msg: 'No schedules found for today',
        trafficInfo: [] 
      });
    }
    
    // Get traffic information for each schedule with a location
    const trafficInfo = [];
    for (const schedule of schedules) {
      if (schedule.location) {
        try {
          // Get traffic data
          const traffic = await getTrafficData(
            user.defaultLocation.coordinates,
            schedule.location.coordinates
          );
          
          // Get route information
          const route = await getRouteInformation(
            user.defaultLocation.coordinates,
            schedule.location.coordinates
          );
          
          // Calculate suggested departure time
          const [hours, minutes] = schedule.startTime.split(':').map(Number);
          const startDateTime = new Date();
          startDateTime.setHours(hours, minutes, 0, 0);
          
          // Subtract travel time (adding 10 minutes buffer)
          const departureTime = new Date(startDateTime.getTime() - ((traffic.travelTimeMinutes + 10) * 60 * 1000));
          
          // Format departure time
          const departureHours = departureTime.getHours();
          const departureMinutes = departureTime.getMinutes();
          const period = departureHours >= 12 ? 'PM' : 'AM';
          const formattedHour = departureHours % 12 === 0 ? 12 : departureHours % 12;
          const formattedMinutes = departureMinutes.toString().padStart(2, '0');
          const suggestedDepartureTime = `${formattedHour}:${formattedMinutes} ${period}`;
          
          trafficInfo.push({
            scheduleId: schedule._id,
            scheduleTitle: schedule.title,
            startTime: schedule.startTime,
            location: {
              id: schedule.location._id,
              name: schedule.location.name,
              address: schedule.location.address,
              city: schedule.location.city,
              coordinates: schedule.location.coordinates
            },
            traffic: {
              condition: traffic.trafficCondition,
              travelTimeMinutes: traffic.travelTimeMinutes,
              distance: route.distanceInKilometers,
              suggestedDepartureTime
            },
            route: {
              polyline: route.polyline,
              steps: route.steps
            }
          });
        } catch (error) {
          console.error(`Error getting traffic data for schedule ${schedule._id}:`, error);
        }
      }
    }
    
    res.json({
      defaultLocation: {
        id: user.defaultLocation._id,
        name: user.defaultLocation.name,
        address: user.defaultLocation.address,
        city: user.defaultLocation.city,
        coordinates: user.defaultLocation.coordinates
      },
      trafficInfo
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/traffic/route
// @desc    Get route information between two locations
// @access  Private
router.get('/route', auth, async (req, res) => {
  const { originId, destinationId } = req.query;
  
  try {
    // Check if both origin and destination are provided
    if (!originId && !destinationId) {
      return res.status(400).json({ msg: 'Both origin and destination are required' });
    }
    
    // Get locations
    const origin = await Location.findById(originId);
    const destination = await Location.findById(destinationId);
    
    if (!origin || !destination) {
      return res.status(404).json({ msg: 'One or both locations not found' });
    }
    
    // Get route information
    const route = await getRouteInformation(
      origin.coordinates,
      destination.coordinates
    );
    
    // Get traffic data
    const traffic = await getTrafficData(
      origin.coordinates,
      destination.coordinates
    );
    
    res.json({
      origin: {
        id: origin._id,
        name: origin.name,
        address: origin.address,
        city: origin.city,
        coordinates: origin.coordinates
      },
      destination: {
        id: destination._id,
        name: destination.name,
        address: destination.address,
        city: destination.city,
        coordinates: destination.coordinates
      },
      route: {
        distance: route.distanceInKilometers,
        polyline: route.polyline,
        steps: route.steps
      },
      traffic: {
        condition: traffic.trafficCondition,
        travelTimeMinutes: traffic.travelTimeMinutes
      }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/traffic/location/:locationId
// @desc    Get traffic information to a specific location from user's default location
// @access  Private
router.get('/location/:locationId', auth, async (req, res) => {
  try {
    // Get user with populated default location
    const user = await User.findById(req.user.id).populate('defaultLocation');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // Check if user has a default location set
    if (!user.defaultLocation) {
      return res.status(400).json({ 
        msg: 'Default location not set. Please set your default location to get traffic information.',
        needsDefaultLocation: true
      });
    }
    
    // Get destination location
    const destination = await Location.findById(req.params.locationId);
    
    if (!destination) {
      return res.status(404).json({ msg: 'Destination location not found' });
    }
    
    // Get traffic data
    const traffic = await getTrafficData(
      user.defaultLocation.coordinates,
      destination.coordinates
    );
    
    // Get route information
    const route = await getRouteInformation(
      user.defaultLocation.coordinates,
      destination.coordinates
    );
    
    res.json({
      origin: {
        id: user.defaultLocation._id,
        name: user.defaultLocation.name,
        address: user.defaultLocation.address,
        city: user.defaultLocation.city,
        coordinates: user.defaultLocation.coordinates
      },
      destination: {
        id: destination._id,
        name: destination.name,
        address: destination.address,
        city: destination.city,
        coordinates: destination.coordinates
      },
      traffic: {
        condition: traffic.trafficCondition,
        travelTimeMinutes: traffic.travelTimeMinutes,
        distance: route.distanceInKilometers
      },
      route: {
        polyline: route.polyline,
        steps: route.steps
      }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;