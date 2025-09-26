import { Router } from 'express';

const router = Router();

router.get('/', async (req, res) => {
  res.status(200).json({ message: 'List projects route (to be implemented)' });
});

export default router;