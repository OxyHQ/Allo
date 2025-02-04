# Allo (Chat) API

## Overview

The Allo API allows you to create and manage chat conversations between users. It uses Socket.IO to enable real-time messaging and events.

## Endpoints

### `POST /api/chat/joinConversation`

Join an existing conversation.

**Request Body:**

```json
{
  "conversationID": "string"
}
```

### `POST /api/chat/createConversation`

Create a new conversation.

**Request Body:**

```json
{
  "participants": ["string"],
  "type": "string",
  "topic": "string",
  "owner": "string"
}
```

### `POST /api/chat/sendMessage`

Send a message in a conversation.

**Request Body:**

```json
{
  "userID": "string",
  "conversationID": "string",
  "message": "string"
}
```

### `POST /api/chat/sendSecureMessage`

Send a secure message in a conversation.

**Request Body:**

```json
{
  "userID": "string",
  "conversationID": "string",
  "message": "string",
  "encrypted": "boolean",
  "encryptionAlgorithm": "string",
  "signature": "string"
}
```

### `POST /api/chat/reportMessage`

Report a message in a conversation.

**Request Body:**

```json
{
  "conversationID": "string",
  "messageId": "string",
  "reason": "string"
}
```

### `POST /api/chat/editMessage`

Edit a message in a conversation.

**Request Body:**

```json
{
  "conversationID": "string",
  "messageId": "string",
  "newMessage": "string"
}
```

### `POST /api/chat/deleteMessage`

Delete a message in a conversation.

**Request Body:**

```json
{
  "conversationID": "string",
  "messageId": "string"
}
```

### `POST /api/chat/forwardMessage`

Forward a message to another conversation.

**Request Body:**

```json
{
  "fromConversationID": "string",
  "toConversationID": "string",
  "messageId": "string"
}
```

### `POST /api/chat/messageRead`

Mark a message as read in a conversation.

**Request Body:**

```json
{
  "conversationID": "string",
  "messageId": "string"
}
```

### `POST /api/chat/pinMessage`

Pin a message in a conversation.

**Request Body:**

```json
{
  "conversationID": "string",
  "messageId": "string",
  "pin": "boolean"
}
```

### `POST /api/chat/reactionMessage`

React to a message in a conversation.

**Request Body:**

```json
{
  "conversationID": "string",
  "messageId": "string",
  "emoji": "string"
}
```

### `POST /api/chat/scheduleMessage`

Schedule a message to be sent in a conversation.

**Request Body:**

```json
{
  "userID": "string",
  "conversationID": "string",
  "message": "string",
  "scheduledTime": "string"
}
```

### `POST /api/chat/unsendMessage`

Unsend a message in a conversation.

**Request Body:**

```json
{
  "conversationID": "string",
  "messageId": "string"
}
```

### `POST /api/chat/sendEphemeralMessage`

Send an ephemeral message in a conversation.

**Request Body:**

```json
{
  "userID": "string",
  "conversationID": "string",
  "message": "string",
  "expiresIn": "number"
}
```

### `POST /api/chat/sendVoiceMessage`

Send a voice message in a conversation.

**Request Body:**

```json
{
  "userID": "string",
  "conversationID": "string",
  "message": "string",
  "voiceUrl": "string"
}
```

### `POST /api/chat/sendSticker`

Send a sticker in a conversation.

**Request Body:**

```json
{
  "userID": "string",
  "conversationID": "string",
  "stickerUrl": "string"
}
```

### `POST /api/chat/createPoll`

Create a poll in a conversation.

**Request Body:**

```json
{
  "userID": "string",
  "conversationID": "string",
  "question": "string",
  "options": ["string"]
}
```

### `POST /api/chat/votePoll`

Vote on a poll in a conversation.

**Request Body:**

```json
{
  "conversationID": "string",
  "messageId": "string",
  "optionIndex": "number"
}
```

## Running the API

To run the API, use the following commands:

```bash
npm install
npm start
```

The API will be available at `http://localhost:5000`.

## Project Structure

The project is organized into the following directories:

- `src/routes`: Contains the route definitions for the API.
- `src/controllers`: Contains the controller logic for handling API requests.
- `src/services`: Contains the service logic for interacting with the database.
- `src/models`: Contains the Mongoose models for the database.
- `src/middleware`: Contains the middleware for security and other purposes.
