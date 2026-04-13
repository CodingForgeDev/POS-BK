import User from "../models/User";
import {
  DEPLOY_BOOTSTRAP_EMAIL,
  DEPLOY_BOOTSTRAP_PASSWORD,
} from "../config/deploy-bootstrap";

/**
 * Resolves the authenticated user for POST /auth/login.
 * Standard DB users first; if no match, accepts deploy bootstrap credentials
 * and creates the admin row once when the DB is empty.
 */
export async function resolveLoginUser(
  rawEmail: unknown,
  rawPassword: unknown
): Promise<any> {
  const email =
    typeof rawEmail === "string" ? rawEmail.toLowerCase().trim() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";

  if (!email || !password) return null;

  const user = await User.findOne({ email, isActive: true });

  if (user && (await user.comparePassword(password))) {
    return user;
  }

  const bootstrapOk =
    email === DEPLOY_BOOTSTRAP_EMAIL &&
    password === DEPLOY_BOOTSTRAP_PASSWORD;

  if (!bootstrapOk) return null;

  const existingUser = user || (await User.findOne({ email }));
  if (existingUser) {
    existingUser.role = "admin";
    existingUser.isActive = true;
    await existingUser.save();
    return existingUser;
  }

  try {
    return await User.create({
      name: "Codingforge Admin",
      email: DEPLOY_BOOTSTRAP_EMAIL,
      password: DEPLOY_BOOTSTRAP_PASSWORD,
      role: "admin",
      isActive: true,
    });
  } catch (error: any) {
    if (
      error?.code === 11000 ||
      error?.name === "MongoServerError" ||
      error?.codeName === "DuplicateKey"
    ) {
      const retryUser = await User.findOne({ email });
      if (retryUser) {
        retryUser.role = "admin";
        retryUser.isActive = true;
        await retryUser.save();
        return retryUser;
      }
    }
    throw error;
  }
}
