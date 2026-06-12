import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

// Silence the connector's own logs during tests; expectations still surface
// failures. (The logger never logs secrets/bodies, but tests shouldn't be noisy.)
jest.spyOn(console, "log").mockImplementation(() => undefined);
jest.spyOn(console, "warn").mockImplementation(() => undefined);
jest.spyOn(console, "error").mockImplementation(() => undefined);
jest.spyOn(console, "debug").mockImplementation(() => undefined);

let mongoServer: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  process.env.BRIDGE_MONGODB_URI = uri;
  await mongoose.connect(uri, { dbName: "allo-bridge-test" });
}, 120000);

afterEach(async () => {
  if (mongoose.connection.readyState !== 1) return;
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    try {
      await collections[key].deleteMany({});
    } catch {
      // intentional: a collection may not exist yet in a given test
    }
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});
