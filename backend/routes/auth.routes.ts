import { Router } from "express";
import { registerUser, loginUser } from "../controllers/auth.controller";

const router = Router();

// Route to register a new user
router.post("/register", registerUser);

// Route to log in an existing user
router.post("/login", loginUser);

export default router;
