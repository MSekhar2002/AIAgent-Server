const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
  // Get token from header
  let token = req.header('x-auth-token');
  
  // Log token for debugging (remove in production)
  console.log('Received token:', token ? `${token.substring(0, 10)}...` : 'none');
  
  // Sanitize token if it exists
  if (token) {
    token = token.trim();
  }
  
  // Check if no token
  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  // Verify token
  try {
    // Check if JWT_SECRET is defined
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not defined in environment variables');
      return res.status(500).json({ msg: 'Server configuration error' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if decoded token has the expected structure
    if (!decoded.user || !decoded.user.id) {
      console.error('Decoded token missing user data:', decoded);
      return res.status(401).json({ msg: 'Invalid token structure' });
    }
    
    req.user = decoded.user;
    next();
  } catch (err) {
    console.error('Token verification error:', err.message);
    res.status(401).json({ msg: `Token is not valid: ${err.message}` });
  }
};