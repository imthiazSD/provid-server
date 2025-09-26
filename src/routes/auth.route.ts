import { Router } from 'express';

const router = Router();

router.post('/signup', async (req, res) => {
  res.status(201).json({ message: 'Signup route (to be implemented)' });
});

router.post('/signin', async (req, res) => {
  res.status(200).json({ message: 'Signin route (to be implemented)' });
});

export default router;