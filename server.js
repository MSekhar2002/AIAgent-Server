const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// Middleware
app.use(express.json({ extended: false }));
app.use(cors());

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