import { Router, Request, Response } from "express";
import User from "../models/User";
import { connectDB } from "../lib/mongodb";
import { signToken } from "../lib/jwt";
import { sendSuccess, sendError } from "../lib/utils";
import { authenticate } from "../middleware/auth";

const router = Router();

router.post("/login", async (req: Request, res: Response) => {
  try {
    await connectDB();
    const { email, password } = req.body;

    if (!email || !password) {
      return sendError(res, "Email and password are required", 400);
    }

    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return sendError(res, "Invalid email or password", 401);
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return sendError(res, "Invalid email or password", 401);
    }

    const token = signToken({
      id: user._id,
      role: user.role,
      name: user.name,
      email: user.email,
    });

    res.cookie("pos_token", token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });

    return sendSuccess(
      res,
      { user: user.toSafeObject(), token },
      "Login successful"
    );
  } catch (error) {
    console.error("Login error:", error);
    return sendError(res, "Internal server error", 500);
  }
});

router.post("/logout", authenticate, (_req: Request, res: Response) => {
  res.clearCookie("pos_token");
  return sendSuccess(res, null, "Logged out successfully");
});

export default router;
