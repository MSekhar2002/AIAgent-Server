const nodemailer = require('nodemailer');

// Create reusable transporter object using SMTP transport
const createTransporter = () => {
  return nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  });
};

/**
 * Send an email
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} text - Plain text content
 * @param {string} html - HTML content (optional)
 */
const sendEmail = async (to, subject, text, html) => {
  try {
    const transporter = createTransporter();
    
    const mailOptions = {
      from: `Employee Scheduling System <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
      html: html || text
    };
    
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
    return info;
  } catch (error) {
    console.error('Email sending error:', error.message);
    throw error;
  }
};

/**
 * Send welcome email to new employee
 * @param {Object} user - User object
 */
const sendWelcomeEmail = async (user) => {
  const subject = 'Welcome to the Employee Scheduling System';
  const text = `
Hello ${user.name},/n/n

Welcome to the Employee Scheduling System! Your account has been created successfully./n/n

Your login credentials:/n
Email: ${user.email}/n
Password: (The password set by your administrator)/n/n

Please log in to the system to view your schedule and update your profile./n/n

Best regards,/n
The Management Team
  `;
  
  return sendEmail(user.email, subject, text);
};

/**
 * Send schedule notification to employee
 * @param {Object} user - User object
 * @param {Object} schedule - Schedule object
 * @param {Object} location - Location object
 */
const sendScheduleNotification = async (user, schedule, location) => {
  const subject = `Schedule Update: ${schedule.title}`;
  const text = `
Hello ${user.name},

You have been assigned to the following schedule:/n/n

Title: ${schedule.title} /n
Date: ${new Date(schedule.date).toLocaleDateString()} /n
Time: ${schedule.startTime} - ${schedule.endTime}/n
Location: ${location.name}, ${location.address}, ${location.city}, ${location.state}/n/n

Please log in to the system for more details./n/n

Best regards,/n
The Management Team
  `;
  
  return sendEmail(user.email, subject, text);
};

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendScheduleNotification
};