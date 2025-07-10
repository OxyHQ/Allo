import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import User from "../modals/User";
import { generateToken } from "../utils/token";

// Register Function
export const registerUser = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { email, password, name, avatar } = req.body;
  try {
    // Check if the user already exists
    let user = await User.findOne({ email });

    if (user) {
      res.status(400).json({ success: false, msg: "User already exists" });
      return;
    }

    // Create new user instance
    user = new User({
      email,
      password,
      name,
      avatar: avatar || "",
    });

    // Hash the password before saving
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    // Save the user to the database
    await user.save();

    // Generate token using utility function
    const token = generateToken(user);

    res.json({
      success: true,
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, msg: "Server error" });
  }
};

// Login Function
export const loginUser = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  try {
    // find user by email
    const user = await User.findOne({ email });
    if (!user) {
      res.status(400).json({ success: false, msg: "Invalid credentials" });
      return;
    }

    // Compare provided password with the hashed password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(400).json({ success: false, msg: "Invalid credentials" });
      return;
    }

    // Generate token using utility function
    const token = generateToken(user);

    res.json({
      success: true,
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, msg: "Server error" });
  }
};
