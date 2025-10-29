import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { authSchemas } from '../validation/schemas';

const router = Router();
const authController = new AuthController();

router.post('/signup', validate(authSchemas.signup), authController.signup.bind(authController));
router.post('/signin', validate(authSchemas.signin), authController.signin.bind(authController));
router.get('/profile', authMiddleware, authController.getProfile.bind(authController));

export default router;
