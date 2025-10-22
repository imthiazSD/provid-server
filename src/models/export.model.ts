import mongoose, { Document, Schema } from 'mongoose';

export interface IExportRequest extends Document {
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  renderId?: string; // Remotion render ID
  bucketName?: string; // S3 bucket name from Remotion
  queueMessageId?: string; // SQS message ID (if using custom queue)
  outputUrl?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const exportRequestSchema = new Schema<IExportRequest>({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
    index: true
  },
  renderId: {
    type: String,
    sparse: true,
    index: true
  },
  bucketName: {
    type: String
  },
  queueMessageId: {
    type: String
  },
  outputUrl: {
    type: String
  },
  errorMessage: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Index for finding active exports
exportRequestSchema.index({ projectId: 1, status: 1 });
exportRequestSchema.index({ userId: 1, createdAt: -1 });

export const ExportRequest = mongoose.model<IExportRequest>('ExportRequest', exportRequestSchema);