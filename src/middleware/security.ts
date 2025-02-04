import rateLimit from "express-rate-limit";
import slowDown from "express-slow-down";
import csrf from "csurf";
import cookieParser from "cookie-parser"; // Import cookie-parser
import { Request, Response, NextFunction } from "express";

// Rate limiting middleware
const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50000, // limit each IP to 100 requests per window
  message: "Too many requests from this IP, please try again later.",
});

// Brute force protection middleware
const bruteForceProtection = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50000, // allow 100 requests per 15 minutes, then...
  delayMs: () => 500, // add 500ms delay per request above 100 (new behavior)
});

// Middleware to parse cookies
const parseCookies = cookieParser();

// CSRF protection middleware
const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  },
});

// Error handling middleware for CSRF token errors
const csrfErrorHandler = (err: { code: string }, req: Request, res: Response, next: NextFunction) => {
  if (err.code !== "EBADCSRFTOKEN") return next(err);

  res.status(403);
  res.send("Form tampered with");
};

export { rateLimiter, bruteForceProtection, csrfProtection, parseCookies, csrfErrorHandler };
