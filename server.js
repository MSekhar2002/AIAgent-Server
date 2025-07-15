const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// CORS configuration - MUST be first
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://ai-agent-psi-six.vercel.app',
      'http://localhost:3000',
      'http://localhost:5000',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5000'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'x-auth-token',
    'Cache-Control',
    'Pragma'
  ],
  exposedHeaders: ['x-auth-token'],
  optionsSuccessStatus: 200,
  preflightContinue: false
};

// Apply CORS middleware FIRST - before any other middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Add security headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

// Other middleware AFTER CORS
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb', extended: false }));

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Server is running correctly' });
});

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI || 'mongodb://localhost:27017/employee-scheduling', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('MongoDB Connected'))
  .catch((err) => {
    console.error('MongoDB Connection Error:', err.message);
    process.exit(1);
  });

// Define Routes
app.use('/api/auth', require('./routes/api/auth'));
app.use('/api/users', require('./routes/api/users'));
app.use('/api/schedules', require('./routes/api/schedules'));
app.use('/api/locations', require('./routes/api/locations'));
app.use('/api/notifications', require('./routes/api/notifications'));
app.use('/api/whatsapp', require('./routes/api/whatsapp'));
app.use('/api/dashboard', require('./routes/api/dashboard'));
app.use('/api/absences', require('./routes/api/absences'));
app.use('/api/hour-tracking', require('./routes/api/hourTracking'));
app.use('/api/language-settings', require('./routes/api/languageSettings'));
app.use('/api/daily-briefing', require('./routes/api/dailyBriefing'));
app.use('/api/schedule-matrix', require('./routes/api/scheduleMatrix'));
app.use('/api/traffic', require('./routes/api/traffic'));
app.use('/api/teams', require('./routes/api/teams'));

// Serve static assets in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static('client/build'));
  app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'client', 'build', 'index.html'));
  });
}

// Define port
const PORT = process.env.PORT || 5000;

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
