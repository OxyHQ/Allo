# 💬 Bubbly - Full Stack Chat App

A modern, real-time chat application built with React Native and Node.js, featuring instant messaging, user authentication, and cross-platform support.

![License](https://img.shields.io/badge/License-Custom-blue.svg)
![React Native](https://img.shields.io/badge/React%20Native-0.79.2-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-Express-green.svg)
![Socket.io](https://img.shields.io/badge/Socket.io-4.8.1-black.svg)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-green.svg)

## ✨ Features

- 🚀 **Real-time messaging** with Socket.io
- 🔐 **User authentication** with JWT tokens
- 📱 **Cross-platform** support (iOS, Android, Web)
- 🖼️ **Media sharing** with image upload support
- 💾 **Persistent storage** with MongoDB Atlas
- 🎨 **Modern UI** with Expo and React Native
- 🔄 **Live updates** without page refresh
- 🌐 **RESTful API** architecture

## 🏗️ Tech Stack

### Frontend
- **React Native** - Cross-platform mobile framework
- **Expo** - Development platform and tools
- **TypeScript** - Type-safe JavaScript
- **Socket.io Client** - Real-time communication
- **React Navigation** - Navigation library
- **Axios** - HTTP client
- **JWT Decode** - Token management
- **Moment.js** - Date/time handling

### Backend
- **Node.js** - JavaScript runtime
- **Express.js** - Web framework
- **TypeScript** - Type-safe JavaScript
- **Socket.io** - Real-time communication
- **MongoDB** - NoSQL database
- **Mongoose** - MongoDB object modeling
- **JWT** - JSON Web Tokens for auth
- **bcryptjs** - Password hashing
- **CORS** - Cross-origin resource sharing

## 📁 Project Structure

```
chat-app-socket.io/
├── frontend/                 # React Native app
│   ├── app/                 # App screens and routing
│   ├── components/          # Reusable UI components
│   ├── contexts/            # React contexts
│   ├── hooks/               # Custom React hooks
│   ├── services/            # API services
│   ├── socket/              # Socket.io client setup
│   ├── utils/               # Utility functions
│   └── package.json
├── backend/                 # Node.js server
│   ├── config/              # Database configuration
│   ├── controllers/         # Route controllers
│   ├── models/              # Database models
│   ├── routes/              # API routes
│   ├── socket/              # Socket.io server setup
│   ├── utils/               # Utility functions
│   ├── index.ts             # Server entry point
│   └── package.json
├── Installation-guide.txt   # Detailed setup guide
└── README.md               # This file
```

## 🚀 Quick Start

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Expo CLI (for mobile development)
- MongoDB Atlas account
- Git

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd chat-app-socket.io
   ```

2. **Install root dependencies**
   ```bash
   npm install
   ```

3. **Set up the backend**
   ```bash
   cd backend
   npm install
   cp example.env .env
   # Edit .env with your MongoDB URI and JWT secret
   npm run dev
   ```

4. **Set up the frontend**
   ```bash
   cd frontend
   npm install
   npm start
   ```

### Environment Setup

Create a `.env` file in the backend directory:

```env
MONGO_URI=your_mongodb_atlas_connection_string
JWT_SECRET=your_jwt_secret_key
PORT=3000
```

## 📱 Running the App

### Backend Server
```bash
cd backend
npm run dev
```
The server will start on `http://localhost:3000`

### Frontend App
```bash
cd frontend
npm start
```

This will open the Expo development server. You can then:
- Scan the QR code with Expo Go app (mobile)
- Press `w` to open in web browser
- Press `a` to open Android emulator
- Press `i` to open iOS simulator

## 🌐 Database Setup

### MongoDB Atlas (Recommended)

1. Visit [MongoDB Atlas](https://www.mongodb.com/atlas)
2. Create a free account and cluster
3. Create a database user
4. Whitelist your IP address (or allow from anywhere for development)
5. Get your connection string and add it to `.env`

For detailed MongoDB setup instructions, see `Installation-guide.txt`.

## 🔧 Available Scripts

### Backend
- `npm run dev` - Start development server with nodemon
- `npm run build` - Build TypeScript files
- `npm test` - Run tests

### Frontend
- `npm start` - Start Expo development server
- `npm run android` - Run on Android
- `npm run ios` - Run on iOS
- `npm run web` - Run on web
- `npm run lint` - Run ESLint

## 🚀 Deployment

### Backend Deployment
The backend can be deployed to platforms like:
- Heroku
- Railway
- Vercel
- DigitalOcean
- AWS

### Frontend Deployment
The React Native app can be built for:
- **iOS**: App Store via Expo Application Services (EAS)
- **Android**: Google Play Store via EAS
- **Web**: Static hosting platforms (Netlify, Vercel)

## 📱 Platform Support

- ✅ iOS
- ✅ Android  
- ✅ Web
- ✅ Development build
- ✅ Expo Go

## 🔐 Authentication Flow

1. User registers/logs in with credentials
2. Server validates and returns JWT token
3. Client stores token locally
4. Token included in API requests and Socket.io connection
5. Server validates token for protected routes

## 📡 Real-time Features

- Instant message delivery
- Online/offline status
- Typing indicators
- Message read receipts
- Live user presence

## 🛠️ Development

### Code Style
- TypeScript for type safety
- ESLint for code quality
- Consistent file naming
- Component-based architecture

### Folder Conventions
- `components/` - Reusable UI components
- `screens/` - App screens/pages  
- `services/` - API and external services
- `utils/` - Helper functions
- `types/` - TypeScript type definitions

## 🐛 Troubleshooting

### Common Issues

1. **Metro bundler issues**: Clear cache with `npx expo start --clear`
2. **Socket connection fails**: Check server is running and firewall settings
3. **Database connection**: Verify MongoDB URI and network access
4. **Package conflicts**: Delete `node_modules` and reinstall

### Getting Help

1. Check the `Installation-guide.txt` for detailed setup steps
2. Review console logs for error messages
3. Ensure all environment variables are set correctly

## 📄 License

This project is licensed under a custom license by Code With Nomi. See `LICENSE.txt` for details.

**Key Points:**
- ✅ Free to use and modify for personal use
- ❌ No commercial use permitted
- ❌ No redistribution allowed
- ❌ No attribution required

## 👨‍💻 Author

**Code With Nomi**

---

## 🤝 Contributing

This project has specific licensing restrictions. Please review the `LICENSE.txt` file before making any contributions.

---

**Happy Chatting! 💬✨** 