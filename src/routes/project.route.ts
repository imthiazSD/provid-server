import { Router } from 'express';
import { ProjectController } from '../controllers/project.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { projectSchemas } from '../validation/schemas';

const router = Router();
const projectController = new ProjectController();

// All routes require authentication
router.use(authMiddleware);

router.get('/', projectController.getProjects.bind(projectController));
router.post(
  '/',
  validate(projectSchemas.create),
  projectController.createProject.bind(projectController)
);
router.get('/:projectId', projectController.getProject.bind(projectController));
router.put(
  '/:projectId',
  validate(projectSchemas.update),
  projectController.updateProject.bind(projectController)
);
router.post(
  '/:projectId/autosave',
  validate(projectSchemas.autosave),
  projectController.autosave.bind(projectController)
);
router.delete('/:projectId', projectController.deleteProject.bind(projectController));

export default router;
