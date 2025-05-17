const axios = require('axios');

/**
 * Get Azure Maps API key from environment variables
 * @returns {string} Azure Maps API key
 */
const getAzureMapsKey = () => {
  const apiKey = process.env.AZURE_MAPS_KEY;
  
  if (!apiKey) {
    throw new Error('Azure Maps API key not configured');
  }
  
  return apiKey;
};

/**
 * Get traffic data for a specific location
 * @param {Object} coordinates - Location coordinates
 * @param {number} coordinates.latitude - Latitude
 * @param {number} coordinates.longitude - Longitude
 * @returns {Promise<Object>} Traffic data
 */
const getTrafficData = async (coordinates) => {
  try {
    const apiKey = getAzureMapsKey();
    const { latitude, longitude } = coordinates;
    
    // Call Azure Maps Traffic API
    const response = await axios.get(
      `https://atlas.microsoft.com/traffic/flow/segment/json`,
      {
        params: {
          'subscription-key': apiKey,
          'api-version': '1.0',
          'style': 'absolute',
          'zoom': 10,
          'query': `${latitude},${longitude}`
        }
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('Azure Maps traffic data error:', error.message);
    
    // Return mock data for development/demo purposes
    return generateMockTrafficData();
  }
};

/**
 * Get route information between two locations
 * @param {Object} origin - Origin coordinates
 * @param {number} origin.latitude - Origin latitude
 * @param {number} origin.longitude - Origin longitude
 * @param {Object} destination - Destination coordinates
 * @param {number} destination.latitude - Destination latitude
 * @param {number} destination.longitude - Destination longitude
 * @returns {Promise<Object>} Route information
 */
const getRouteInfo = async (origin, destination) => {
  try {
    const apiKey = getAzureMapsKey();
    
    // Call Azure Maps Route API
    const response = await axios.get(
      `https://atlas.microsoft.com/route/directions/json`,
      {
        params: {
          'subscription-key': apiKey,
          'api-version': '1.0',
          'query': `${origin.latitude},${origin.longitude}:${destination.latitude},${destination.longitude}`,
          'traffic': true,
          'computeTravelTimeFor': 'all',
          'routeType': 'fastest',
          'alternatives': true,
          'maxAlternatives': 2
        }
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('Azure Maps route info error:', error.message);
    
    // Return mock data for development/demo purposes
    return generateMockRouteData(origin, destination);
  }
};

/**
 * Generate mock traffic data for development/demo purposes
 * @returns {Object} Mock traffic data
 */
const generateMockTrafficData = () => {
  return {
    flowSegmentData: {
      freeFlowSpeed: 65,
      currentSpeed: Math.floor(Math.random() * 65) + 10,
      currentTravelTime: Math.floor(Math.random() * 30) + 5,
      trafficLevel: Math.floor(Math.random() * 5),
      trafficLevelDescription: ['No data', 'Free flow', 'Sluggish', 'Heavy', 'Congested', 'Blocked'][Math.floor(Math.random() * 6)]
    }
  };
};

/**
 * Generate mock route data for development/demo purposes
 * @param {Object} origin - Origin coordinates
 * @param {Object} destination - Destination coordinates
 * @returns {Object} Mock route data
 */
const generateMockRouteData = (origin, destination) => {
  // Calculate mock distance based on coordinates (very simplified)
  const distance = Math.sqrt(
    Math.pow(destination.latitude - origin.latitude, 2) +
    Math.pow(destination.longitude - origin.longitude, 2)
  ) * 111; // Rough conversion to kilometers
  
  const trafficLevel = Math.floor(Math.random() * 5);
  const baseSpeed = 60; // km/h
  const trafficFactor = 1 - (trafficLevel * 0.15);
  const speed = baseSpeed * trafficFactor;
  const travelTime = (distance / speed) * 60; // minutes
  
  return {
    routes: [
      {
        summary: {
          lengthInMeters: Math.round(distance * 1000),
          travelTimeInSeconds: Math.round(travelTime * 60),
          trafficDelayInSeconds: Math.round(trafficLevel * 300),
          departureTime: new Date().toISOString(),
          arrivalTime: new Date(Date.now() + (travelTime * 60 * 1000)).toISOString()
        },
        legs: [
          {
            summary: {
              lengthInMeters: Math.round(distance * 1000),
              travelTimeInSeconds: Math.round(travelTime * 60),
              trafficDelayInSeconds: Math.round(trafficLevel * 300)
            }
          }
        ]
      },
      {
        summary: {
          lengthInMeters: Math.round(distance * 1000 * 1.2),
          travelTimeInSeconds: Math.round(travelTime * 60 * 1.1),
          trafficDelayInSeconds: Math.round(trafficLevel * 200),
          departureTime: new Date().toISOString(),
          arrivalTime: new Date(Date.now() + (travelTime * 1.1 * 60 * 1000)).toISOString()
        },
        legs: [
          {
            summary: {
              lengthInMeters: Math.round(distance * 1000 * 1.2),
              travelTimeInSeconds: Math.round(travelTime * 60 * 1.1),
              trafficDelayInSeconds: Math.round(trafficLevel * 200)
            }
          }
        ]
      }
    ]
  };
};

module.exports = {
  getTrafficData,
  getRouteInfo
};