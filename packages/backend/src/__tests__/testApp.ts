import express from "express";

// Mock the real server module so route files can `import { oxy } from "../../server"`
// without booting Express, Socket.IO, dotenv, etc.
//
// The mocked `oxy.auth()` behaves like the real one at the HTTP contract level:
// requests without a Bearer token get 401; with a token, `req.user.id` is set
// from the token (stripping an optional "test:" prefix).
jest.mock("../../server", () => ({
  oxy: {
    auth:
      () =>
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res
            .status(401)
            .json({ error: "Unauthorized", message: "Authentication required" });
        }
        const token = authHeader.slice("Bearer ".length).trim();
        const userId = token.startsWith("test:") ? token.slice("test:".length) : token;
        (req as express.Request & { user: { id: string }; userId: string }).user = {
          id: userId,
        };
        (req as express.Request & { user: { id: string }; userId: string }).userId = userId;
        next();
      },
    authSocket: () => (_socket: unknown, next: (err?: Error) => void) => next(),
    getUserById: jest.fn(async (id: string) => ({
      id,
      username: `user_${id}`,
      handle: `user_${id}`,
      name: { first: "User", last: id },
      avatar: undefined,
    })),
  },
}));

export interface MountSpec {
  path: string;
  router: express.Router;
}

export interface BuildAppOptions {
  /** Inject a fake authenticated user without requiring an Authorization header. */
  injectUserId?: string;
  /** Apply the mocked `oxy.auth()` middleware under /api before the routers. */
  withAuth?: boolean;
  /** Routers to mount, e.g. { path: "/api/messages", router: messagesRoutes }. */
  mount: MountSpec[];
}

/** Build an Express app for supertest, mirroring how server.ts mounts routes. */
export function buildApp(opts: BuildAppOptions): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  if (opts.injectUserId) {
    const uid = opts.injectUserId;
    app.use((req, _res, next) => {
      (req as express.Request & { user: { id: string }; userId: string }).user = { id: uid };
      (req as express.Request & { user: { id: string }; userId: string }).userId = uid;
      next();
    });
  }

  if (opts.withAuth) {
    const { oxy } = jest.requireMock("../../server") as {
      oxy: { auth: () => express.RequestHandler };
    };
    app.use("/api", oxy.auth());
  }

  for (const { path, router } of opts.mount) {
    app.use(path, router);
  }

  return app;
}
