const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const admin = require('../../middleware/admin');
const Location = require('../../models/Location');
const User = require('../../models/User');

// @route   POST api/locations
// @desc    Create a location
// @access  Private/Admin
router.post('/', [auth, admin], async (req, res) => {
  const {
    name,
    address,
    city,
    state,
    zipCode,
    country,
    coordinates,
    description,
    
  } = req.body;

  try {
    const user = await User.findById(req.user.id);
    // Create new location
    const newLocation = new Location({
      name,
      address,
      city,
      state,
      zipCode,
      country: country || '',
      coordinates,
      description,
      team: user.team,
      createdBy: req.user.id
    });

    // Save location
    const location = await newLocation.save();

    res.json(location);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/locations
// @desc    Get all locations
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    // Get user with team info
    const user = await User.findById(req.user.id);
    
    let query = {};
    
    // If user has a team, filter locations by team or no team (shared locations)
    if (user.team) {
      query = { $or: [{ team: user.team }, { team: null }] };
    }
    
    const locations = await Location.find(query)
      .populate('createdBy', 'name')
      .sort({ name: 1 });
    
    res.json(locations);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/locations/:id
// @desc    Get location by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const location = await Location.findById(req.params.id)
      .populate('createdBy', 'name');
    
    if (!location) {
      return res.status(404).json({ msg: 'Location not found' });
    }
    
    res.json(location);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Location not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/locations/:id
// @desc    Update location
// @access  Private/Admin
router.put('/:id', [auth, admin], async (req, res) => {
  const {
    name,
    address,
    city,
    state,
    zipCode,
    country,
    coordinates,
    description,
    active
  } = req.body;

  try {
    let location = await Location.findById(req.params.id);
    
    if (!location) {
      return res.status(404).json({ msg: 'Location not found' });
    }
    
    // Build location object
    const locationFields = {};
    if (name) locationFields.name = name;
    if (address) locationFields.address = address;
    if (city) locationFields.city = city;
    if (state) locationFields.state = state;
    if (zipCode) locationFields.zipCode = zipCode;
    if (country) locationFields.country = country;
    if (coordinates) locationFields.coordinates = coordinates;
    if (description !== undefined) locationFields.description = description;
    if (active !== undefined) locationFields.active = active;
    locationFields.updatedAt = Date.now();
    
    // Update location
    location = await Location.findByIdAndUpdate(
      req.params.id,
      { $set: locationFields },
      { new: true }
    ).populate('createdBy', 'name');
    
    res.json(location);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Location not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   DELETE api/locations/:id
// @desc    Delete location
// @access  Private/Admin
router.delete('/:id', [auth, admin], async (req, res) => {
  try {
    const location = await Location.findById(req.params.id);
    
    if (!location) {
      return res.status(404).json({ msg: 'Location not found' });
    }
    
    // Instead of deleting, set active to false
    location.active = false;
    location.updatedAt = Date.now();
    await location.save();
    
    res.json({ msg: 'Location deactivated' });
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Location not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   GET api/locations/:id/traffic
// @desc    Get traffic data for a location
// @access  Private
router.get('/:id/traffic', auth, async (req, res) => {
  try {
    const location = await Location.findById(req.params.id);
    
    if (!location) {
      return res.status(404).json({ msg: 'Location not found' });
    }
    
    // Get traffic data from Azure Maps using the mapsService utility
    try {
      const { getTrafficData } = require('../../utils/mapsService');
      const trafficData = await getTrafficData(location.coordinates);
      
      // Process and return traffic data
      const response = {
        location: {
          name: location.name,
          address: location.address,
          coordinates: location.coordinates
        },
        traffic: trafficData,
        timestamp: new Date()
      };
      
      res.json(response);
    } catch (trafficErr) {
      console.error('Traffic API error:', trafficErr.message);
      res.status(500).json({ msg: 'Failed to retrieve traffic data' });
    }
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Location not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   POST api/locations/route
// @desc    Get route information between two locations
// @access  Private
router.post('/route', auth, async (req, res) => {
  try {
    const { originId, destinationId, userLocation } = req.body;
    
    // Get locations from database or use user's current location
    let origin, destination;
    
    if (userLocation) {
      // Use user's current location as origin
      origin = {
        latitude: userLocation.latitude,
        longitude: userLocation.longitude
      };
    } else if (originId) {
      // Get origin location from database
      const originLocation = await Location.findById(originId);
      if (!originLocation) {
        return res.status(404).json({ msg: 'Origin location not found' });
      }
      origin = originLocation.coordinates;
    } else {
      return res.status(400).json({ msg: 'Either originId or userLocation is required' });
    }
    
    // Get destination location from database
    const destinationLocation = await Location.findById(destinationId);
    if (!destinationLocation) {
      return res.status(404).json({ msg: 'Destination location not found' });
    }
    destination = destinationLocation.coordinates;
    
    // Get route information using mapsService
    const { getRouteInfo } = require('../../utils/mapsService');
    const routeData = await getRouteInfo(origin, destination);
    
    // Process and return route data
    const response = {
      origin: {
        ...(originId ? { id: originId } : {}),
        coordinates: origin
      },
      destination: {
        id: destinationId,
        name: destinationLocation.name,
        address: destinationLocation.address,
        coordinates: destination
      },
      routes: routeData.routes,
      timestamp: new Date()
    };
    
    res.json(response);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;