# Backend Dockerfile for DigitalOcean App Platform
FROM node:18-alpine

WORKDIR /app

# Copy root package files
COPY package*.json ./
COPY packages/backend/package*.json ./packages/backend/
COPY packages/shared-types ./packages/shared-types/

# Install dependencies
RUN npm install --workspace=@allo/backend --workspace=@allo/shared-types

# Copy backend source
COPY packages/backend ./packages/backend

# Build shared types
RUN npm run build:shared-types

# Expose port
EXPOSE 8080

# Start the backend
CMD ["npm", "run", "start:backend"]
