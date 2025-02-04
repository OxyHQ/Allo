# How to Try the Socket.IO Chat API

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

     // IMPORTANT: Create or join a conversation before sending any messages.
     socket.emit("joinConversation", "conversationIdHere");
     
     // Send a message
     socket.emit("sendMessage", {
       userID: socket.id,
       conversationID: "conversationIdHere", // ensure this conversation exists!
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
