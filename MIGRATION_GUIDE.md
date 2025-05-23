# Migration Guide: Twilio to Meta WhatsApp Cloud API

This document outlines the changes made to migrate the WhatsApp integration from Twilio to Meta WhatsApp Cloud API.

## Changes Made

1. **WhatsApp Service**
   - Replaced Twilio client with Meta WhatsApp Cloud API
   - Updated message sending format to match Meta's requirements
   - Modified error handling for Meta API responses

2. **Webhook Handling**
   - Added GET endpoint for Meta webhook verification
   - Updated POST webhook to process Meta's message format
   - Modified media handling for voice messages

3. **Environment Variables**
   - Removed Twilio-specific variables:
     - `TWILIO_ACCOUNT_SID`
     - `TWILIO_AUTH_TOKEN`
     - `TWILIO_PHONE_NUMBER`
   - Added Meta WhatsApp API variables:
     - `META_WHATSAPP_TOKEN`
     - `META_WHATSAPP_PHONE_NUMBER_ID`
     - `META_WHATSAPP_VERIFY_TOKEN`

4. **Dependencies**
   - Removed Twilio dependency
   - Using existing axios dependency for API calls

## Setup Instructions

### 1. Create a Meta Developer Account

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Create a developer account if you don't have one
3. Create a new app or use an existing one

### 2. Set Up WhatsApp Business API

1. In your Meta Developer Dashboard, add the WhatsApp product
2. Follow the setup instructions to connect a phone number
3. Create a system user and generate a permanent token

### 3. Configure Webhooks

1. Set up a webhook in the Meta Developer Dashboard
2. Create a verify token (any random string) and save it
3. Configure the webhook URL to point to your server's `/api/whatsapp/webhook` endpoint
4. Subscribe to the `messages` webhook field

### 4. Update Environment Variables

1. Update your `.env` file with the new variables:
   ```
   META_WHATSAPP_TOKEN=your_meta_whatsapp_token
   META_WHATSAPP_PHONE_NUMBER_ID=your_meta_whatsapp_phone_number_id
   META_WHATSAPP_VERIFY_TOKEN=your_meta_whatsapp_verify_token
   ```

### 5. Test the Integration

1. Restart your server
2. Send a test message to your WhatsApp Business number
3. Verify that the message is received and processed correctly

## Troubleshooting

- **Webhook Verification Fails**: Ensure your verify token matches exactly what you set in the Meta Developer Dashboard
- **Messages Not Received**: Check that you've subscribed to the `messages` webhook field
- **Authorization Errors**: Verify your WhatsApp token is correct and has the necessary permissions
- **Media Processing Issues**: Ensure your server can access Meta's media URLs

## Additional Resources

- [Meta WhatsApp Cloud API Documentation](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Webhook Setup Guide](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks)
- [Message Types Reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages)