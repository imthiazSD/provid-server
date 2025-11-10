import mongoose, { Schema, Document } from 'mongoose';

export interface IExportRequest extends Document {
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed';
  queueMessageId?: string;
  executionArn?: string; // Step Functions execution ARN
  renderId?: string;
  bucketName?: string;
  outputUrl?: string;
  errorMessage?: string;
  progress?: number; // 0-100
  createdAt: Date;
  updatedAt: Date;
}

const ExportRequestSchema = new Schema<IExportRequest>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'queued', 'processing', 'completed', 'failed'],
      default: 'pending',
      required: true,
      index: true,
    },
    queueMessageId: {
      type: String,
      sparse: true,
    },
    executionArn: {
      type: String,
      sparse: true,
      index: true,
    },
    renderId: {
      type: String,
      sparse: true,
    },
    bucketName: {
      type: String,
      sparse: true,
    },
    outputUrl: {
      type: String,
      sparse: true,
    },
    errorMessage: {
      type: String,
    },
    progress: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
ExportRequestSchema.index({ userId: 1, createdAt: -1 });
ExportRequestSchema.index({ projectId: 1, status: 1 });
ExportRequestSchema.index({ status: 1, createdAt: -1 });

export const ExportRequest = mongoose.model<IExportRequest>('ExportRequest', ExportRequestSchema);