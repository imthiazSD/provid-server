import { Router } from 'express';
import multer from 'multer';
import { UploadController } from '../controllers/upload.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { FILE_TYPES, MAX_FILE_SIZE } from '../utils/constants';

const router = Router();
const uploadController = new UploadController();

// Configure multer for memory storage
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE.VIDEO
  },
  fileFilter: (req, file, cb) => {
    if (FILE_TYPES.VIDEO.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only video files are allowed.'));
    }
  }
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE.IMAGE
  },
  fileFilter: (req, file, cb) => {
    if (FILE_TYPES.IMAGE.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only image files are allowed.'));
    }
  }
});

// All routes require authentication
router.use(authMiddleware);

router.post('/:projectId/video', videoUpload.single('video'), uploadController.uploadVideo.bind(uploadController));
router.post('/:projectId/thumbnail', imageUpload.single('thumbnail'), uploadController.uploadThumbnail.bind(uploadController));

export default router;