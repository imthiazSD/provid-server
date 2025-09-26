import { Router } from 'express';

const router = Router();

router.post('/:projectId/video', async (req, res) => {
  res.status(200).json({ message: 'Video upload route (to be implemented)' });
});

export default router;