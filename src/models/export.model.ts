import mongoose, { Document, Schema } from 'mongoose';

export interface IExportRequest extends Document {
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  outputUrl?: string;
  errorMessage?: string;
  queueMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const exportRequestSchema = new Schema<IExportRequest>({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  outputUrl: {
    type: String,
    trim: true
  },
  errorMessage: {
    type: String,
    trim: true
  },
  queueMessageId: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Index for better query performance
exportRequestSchema.index({ userId: 1, createdAt: -1 });
exportRequestSchema.index({ status: 1, createdAt: -1 });

export const ExportRequest = mongoose.model<IExportRequest>('ExportRequest', exportRequestSchema);