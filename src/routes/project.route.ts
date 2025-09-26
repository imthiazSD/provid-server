import { Router } from 'express';
import { ProjectController } from '../controllers/project.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validateRequest, projectSchemas } from '../middleware/validation.middleware';

const router = Router();
const projectController = new ProjectController();

// All routes require authentication
router.use(authMiddleware);

router.get('/', projectController.getProjects.bind(projectController));
router.post('/', validateRequest(projectSchemas.create), projectController.createProject.bind(projectController));
router.get('/:projectId', projectController.getProject.bind(projectController));
router.put('/:projectId', validateRequest(projectSchemas.update), projectController.updateProject.bind(projectController));
router.post('/:projectId/autosave', validateRequest(projectSchemas.autosave), projectController.autosave.bind(projectController));
router.delete('/:projectId', projectController.deleteProject.bind(projectController));

export default router;