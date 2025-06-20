const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
app.get('/', (req, res) => {
  res.json({ message: 'Server is running correctly' });
});

// Middleware
app.use(express.json({ extended: false }));
const corsOptions = {
  origin: 'https://ai-agent-psi-six.vercel.app',
  credentials: true
};

app.use(cors(corsOptions));
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

// Serve static assets in production
if (process.env.NODE_ENV === 'production') {
  // Set static folder
  app.use(express.static('client/build'));

  app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'client', 'build', 'index.html'));
  });
}

// Define port
const PORT = process.env.PORT || 5000;

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
