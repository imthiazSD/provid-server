import mongoose, { Document, Schema } from 'mongoose';
import { CompositionSettings } from '../types';

export interface IProject extends Document {
  title: string;
  userId: mongoose.Types.ObjectId;
  thumbnailUrl?: string;
  previewUrl?: string;
  compositionSettings: CompositionSettings;
  createdAt: Date;
  updatedAt: Date;
}

const layerSchema = new Schema({
  id: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['highlight', 'zoom', 'blur'],
    required: true
  },
  start: {
    type: Number,
    required: true
  },
  introDuration: {
    type: Number,
    required: true
  },
  mainDuration: {
    type: Number,
    required: true
  },
  outroDuration: {
    type: Number,
    required: true
  },
  data: {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    color: String,
    zoomFactor: Number,
    blurAmount: Number,
    transparency: Number
  }
}, { _id: false });

const compositionSettingsSchema = new Schema({
  videoUrl: {
    type: String,
    required: true
  },
  duration: Number,
  fps: {
    type: Number,
    default: 30
  },
  width: {
    type: Number,
    default: 1920
  },
  height: {
    type: Number,
    default: 1080
  },
  layers: [layerSchema]
}, { _id: false });

const projectSchema = new Schema<IProject>({
  title: {
    type: String,
    required: [true, 'Project title is required'],
    trim: true,
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  thumbnailUrl: {
    type: String,
    trim: true
  },
  previewUrl: {
    type: String,
    trim: true
  },
  compositionSettings: {
    type: compositionSettingsSchema,
    default: {
      videoUrl: '',
      layers: [],
      fps: 30,
      width: 1920,
      height: 1080
    }
  }
}, {
  timestamps: true
});

// Index for better query performance
projectSchema.index({ userId: 1, createdAt: -1 });

export const Project = mongoose.model<IProject>('Project', projectSchema);