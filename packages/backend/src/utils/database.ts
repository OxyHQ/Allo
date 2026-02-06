import mongoose from "mongoose";

const APP_NAME = "allo";

let connectPromise: Promise<typeof mongoose> | null = null;

function getDatabaseName(): string {
  const env = process.env.NODE_ENV || "development";
  return `${APP_NAME}-${env}`;
}

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (connectPromise) {
    return connectPromise;
  }

  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI environment variable is not defined");
  }

  const dbName = getDatabaseName();

  connectPromise = mongoose.connect(mongoUri, {
    dbName,
    autoIndex: true,
    autoCreate: true,
    serverSelectionTimeoutMS: 20000,
    socketTimeoutMS: 45000,
  });

  try {
    await connectPromise;
    return mongoose;
  } catch (error) {
    connectPromise = null;
    throw error;
  }
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}


