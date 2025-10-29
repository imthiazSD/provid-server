import { z } from 'zod';

export const authSchemas = {
  signup: z.object({
    email: z.string().email('Please provide a valid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters long'),
    name: z
      .string()
      .trim()
      .min(2, 'Name must be at least 2 characters long')
      .max(50, 'Name cannot exceed 50 characters'),
  }),

  signin: z.object({
    email: z.string().email('Please provide a valid email address'),
    password: z.string().min(1, 'Password is required'),
  }),
};

// === Project ===
const LayerDataSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive('Width must be positive'),
  height: z.number().positive('Height must be positive'),
  color: z.string().optional(),
  zoomFactor: z.number().positive('Zoom factor must be positive').optional(),
  blurAmount: z.number().min(0, 'Blur amount cannot be negative').optional(),
  transparency: z.number().min(0).max(1, 'Transparency must be between 0 and 1').optional(),
});

const LayerSchema = z.object({
  id: z.string(),
  type: z.enum(['highlight', 'zoom', 'blur']),
  start: z.number().min(0, 'Start time cannot be negative'),
  introDuration: z.number().min(0, 'Intro duration cannot be negative'),
  mainDuration: z.number().min(0, 'Main duration cannot be negative'),
  outroDuration: z.number().min(0, 'Outro duration cannot be negative'),
  data: LayerDataSchema,
});

const CompositionSettingsSchema = z.object({
  videoUrl: z.string().url('Invalid video URL'),
  duration: z.number().positive('Duration must be positive').optional(),
  fps: z.number().int().min(1).max(120, 'FPS must be between 1 and 120').optional(),
  width: z.number().int().positive('Width must be positive').optional(),
  height: z.number().int().positive('Height must be positive').optional(),
  layers: z.array(LayerSchema).optional(),
});

export const projectSchemas = {
  create: z.object({
    title: z
      .string()
      .trim()
      .min(1, 'Title cannot be empty')
      .max(100, 'Title cannot exceed 100 characters'),
  }),

  update: z.object({
    title: z.string().trim().min(1).max(100).optional(),
    thumbnailUrl: z.string().url('Invalid thumbnail URL').optional(),
    previewUrl: z.string().url('Invalid preview URL').optional(),
    compositionSettings: CompositionSettingsSchema.optional(),
  }),

  autosave: z.object({
    compositionSettings: CompositionSettingsSchema.required(),
  }),
};

// === Notification  ===
export const notificationSchemas = {
  get: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    read: z.enum(['true', 'false', 'all']).optional(),
  }),
};
