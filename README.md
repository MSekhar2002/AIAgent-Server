# Employee Scheduling System with WhatsApp Integration

A modern employee scheduling system with WhatsApp integration, AI-powered query processing, and location/traffic features.

## Features

- User authentication and role-based access control
- Employee management
- Schedule creation and management
- Notifications via WhatsApp and email
- AI-powered query processing for WhatsApp and voice messages
- Location management with traffic data integration

## Tech Stack

- **Backend:** Node.js, Express, MongoDB
- **Frontend:** React.js, Tailwind CSS
- **Authentication:** JWT, bcrypt
- **Notifications:** Meta WhatsApp Cloud API, Nodemailer (Email)
- **AI Processing:** Azure OpenAI, Azure Speech Services
- **Location & Traffic:** Azure Maps

## Implementation Flow

### Phase 1: Core Setup & Authentication (1-2 days)
- Set up Express server with MongoDB connection
- Implement user model and authentication endpoints
- Create React frontend with authentication screens
- Set up secure JWT handling

### Phase 2: Employee & Schedule Management (2-3 days)
- Implement user CRUD operations
- Create schedule management endpoints
- Develop admin panel UI for employee management
- Build schedule creation and management screens
- Set up basic dashboard with statistics

### Phase 3: Notification System (1-2 days)
- Implement email notification service
- Set up Meta WhatsApp Cloud API integration
- Create notification templates
- Develop notification sending endpoints
- Build notification management UI

### Phase 4: WhatsApp & Voice Integration (2-3 days)
- Create WhatsApp webhook endpoints
- Implement Azure OpenAI integration for processing queries
- Set up Azure Speech Services for voice-to-text
- Build WhatsApp simulator for testing
- Implement conversation context management

### Phase 5: Location & Traffic Features (1-2 days)
- Implement location CRUD operations
- Set up Azure Maps integration for traffic data
- Create traffic information endpoints
- Build location management UI with traffic visualization

### Phase 6: Testing & Refinement (1-2 days)
- End-to-end testing of core flows
- Refinement of UI/UX elements
- Performance optimization
- Bug fixing

## Setup Instructions

### Prerequisites
- Node.js (v14 or higher)
- MongoDB
- Meta Developer Account (for WhatsApp Cloud API)
- Azure account (for OpenAI, Speech Services, and Maps)

### Installation

1. Clone the repository
2. Install server dependencies:
   ```
   npm install
   ```
3. Install client dependencies:
   ```
   npm run client-install
   ```
4. Create a `.env` file in the root directory with the following variables:
   ```
   NODE_ENV=development
   PORT=5000
   MONGO_URI=your_mongodb_connection_string
   JWT_SECRET=your_jwt_secret
   META_WHATSAPP_TOKEN=your_meta_whatsapp_token
META_WHATSAPP_PHONE_NUMBER_ID=your_meta_whatsapp_phone_number_id
META_WHATSAPP_VERIFY_TOKEN=your_meta_whatsapp_verify_token
   EMAIL_SERVICE=your_email_service
   EMAIL_USER=your_email_user
   EMAIL_PASSWORD=your_email_password
   AZURE_OPENAI_KEY=your_azure_openai_key
   AZURE_OPENAI_ENDPOINT=your_azure_openai_endpoint
   AZURE_SPEECH_KEY=your_azure_speech_key
   AZURE_SPEECH_REGION=your_azure_speech_region
   AZURE_MAPS_KEY=your_azure_maps_key
   ```
5. Run the development server:
   ```
   npm run dev
   ```

## Core User Flows

1. **Admin Creates Employee Flow**
2. **Admin Creates Schedule Flow**
3. **Employee WhatsApp Query Flow**
4. **Voice Query Processing Flow**
5. **Traffic Update Flow**

## Deployment Plan

1. **Development Environment Setup**
2. **API Deployment**
3. **Frontend Deployment**
4. **Testing & Debugging**
5. **Final Deployment & Monitoring**# AIAgent-Server
