import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  createBOM,
  getAllBOMs,
  getBOMById,
  updateBOM,
  reapplyBOM,
  postBOM,
  reverseBOM,
  deleteBOM,
  produceNow,
  duplicateRecipe,
} from "../controllers/bomTransaction.controller";

const router = Router();

router.get("/", authenticate, getAllBOMs);
router.get("/:id", authenticate, getBOMById);
router.post("/produce-now", authenticate, produceNow);
router.post("/duplicate-recipe", authenticate, duplicateRecipe);
router.post("/", authenticate, createBOM);
router.put("/:id", authenticate, updateBOM);
router.post("/:id/reapply", authenticate, reapplyBOM);
router.post("/:id/post", authenticate, postBOM);
router.post("/:id/reverse", authenticate, reverseBOM);
router.delete("/:id", authenticate, deleteBOM);

export default router;
