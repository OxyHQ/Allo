# How to Try the Socket.IO Chat API

- Important: A conversation must be joined or created before sending any messages.

1. Open a terminal and run your server, for example:

   ```
   npm start
   ```

   (Make sure your environment variables and MongoDB connection are correctly set.)

2. Open your browser console or create a new Node.js script for testing.

3. Use the Socket.IO client to connect:

   ```javascript
   // If using in browser (make sure to include socket.io client library)
   const socket = io("http://localhost:3000", {
     auth: { token: "valid-token" }
   });
   
   socket.on("connect", () => {
     console.log("Connected with id:", socket.id);

     // Join a conversation (replace 'conversationIdHere' with an actual id)
     socket.emit("joinConversation", "conversationIdHere");
     
     // Send a message
     socket.emit("sendMessage", {
       userID: socket.id,
       conversationID: "conversationIdHere",
       message: "Hello, chat world!"
     });
     
     // Listen for messages
     socket.on("message", (msg) => {
       console.log("Received message: ", msg);
     });
   });
   
   socket.on("error", err => {
     console.error("Socket error:", err);
   });
   ```

4. Watch the server logs and client console for outputs to confirm the events are working.

5. Experiment with other events (e.g. `createConversation`, `reportMessage`, etc.) to test all features.

Note:

- Every message sent via the API must be linked to a conversation.
- Ensure that you create or join a conversation (by using events like "createConversation" or "joinConversation")
  before sending any messages.

## API Endpoints

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

## Project Structure

The project is organized into the following directories:

- `src/routes`: Contains the route definitions for the API.
- `src/controllers`: Contains the controller logic for handling API requests.
- `src/services`: Contains the service logic for interacting with the database.
- `src/models`: Contains the Mongoose models for the database.
- `src/middleware`: Contains the middleware for security and other purposes.
