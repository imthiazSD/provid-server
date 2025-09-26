import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validateRequest, authSchemas } from '../middleware/validation.middleware';

const router = Router();
const authController = new AuthController();

router.post('/signup', validateRequest(authSchemas.signup), authController.signup.bind(authController));
router.post('/signin', validateRequest(authSchemas.signin), authController.signin.bind(authController));
router.get('/profile', authMiddleware, authController.getProfile.bind(authController));

export default router;