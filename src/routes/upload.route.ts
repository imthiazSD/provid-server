import { Router } from "express";
import { UploadController } from "../controllers/upload.controller";
import { authMiddleware } from "../middleware/auth.middleware";
import { upload } from "../middleware/upload.middleware";

const router = Router();
const uploadController = new UploadController();

// Upload video
router.post(
  "/projects/:projectId/video",
  authMiddleware,
  upload.single("video"),
  uploadController.uploadVideo.bind(uploadController)
);

// Upload thumbnail
router.post(
  "/projects/:projectId/thumbnail",
  authMiddleware,
  upload.single("thumbnail"),
  uploadController.uploadThumbnail.bind(uploadController)
);

// Delete video (NEW)
router.delete(
  "/projects/:projectId/video",
  authMiddleware,
  uploadController.deleteVideo.bind(uploadController)
);

export default router;
