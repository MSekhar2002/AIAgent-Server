# WhatsApp Templates Guide

## Welcome Message Template

The welcome message template is used when a new user is added to the system. It sends an automated welcome message to the user's WhatsApp number.

### Template Name: `welcome_message`

### Template Structure

```
Hello {{user_name}},

Welcome to {{company_name}}! We are excited to have you join our team. You can use this number for schedule updates and company announcements.

Reply to this message if you have any questions.
```

### Parameters

1. `{{user_name}}` - User's name
2. `{{company_name}}` - Company name

### How to Create in Meta Business Manager

1. Log in to your [Meta Business Manager](https://business.facebook.com/)
2. Navigate to the WhatsApp Business Account
3. Go to "Message Templates"
4. Click "Create Template"
5. Select category: "UTILITY"
6. Name the template: `welcome_message`
7. Enter the template content as shown above
8. Add the parameters as shown above
9. Submit for approval

## Other Templates

### Schedule Reminder Template

Used to notify employees about their upcoming shifts.

### Template Name: `schedule_reminder`

### Parameters

1. `{{user_name}}` - User's name
2. `{{schedule_date}}` - Date
3. `{{schedule_time}}` - Time
4. `{{location_name}}` - Location

### Schedule Change Template

Used to notify employees about changes to their existing schedules.

### Template Name: `schedule_change`

### Parameters

1. `{{user_name}}` - User's name
2. `{{schedule_date}}` - Date
3. `{{schedule_time}}` - Time
4. `{{location_name}}` - Location

### General Announcement Template

Used for company-wide or department-specific announcements.

### Template Name: `general_announcement`

### Parameters

1. `{{user_name}}` - User's name
2. `{{announcement_message}}` - Message content