import { Router } from 'express';

const router = Router();

router.post('/:projectId/export', async (req, res) => {
  res.status(200).json({ message: 'Export video route (to be implemented)' });
});

export default router;