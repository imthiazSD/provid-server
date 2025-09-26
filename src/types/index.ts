export interface Layer {
    id: string;
    type: "highlight" | "zoom" | "blur";
    start: number;
    introDuration: number;
    mainDuration: number;
    outroDuration: number;
    data: {
      x: number;
      y: number;
      width: number;
      height: number;
      color?: string;
      zoomFactor?: number;
      blurAmount?: number;
      transparency?: number;
    };
  }
  
  export interface CompositionSettings {
    videoUrl: string;
    duration?: number;
    fps?: number;
    width?: number;
    height?: number;
    layers: Layer[];
  }
  
  export interface User {
    _id: string;
    email: string;
    name: string;
    createdAt: Date;
  }
  
  export interface Project {
    _id: string;
    title: string;
    userId: string;
    thumbnailUrl?: string;
    previewUrl?: string;
    compositionSettings: CompositionSettings;
    createdAt: Date;
    updatedAt: Date;
  }
  
  export interface ExportRequest {
    _id: string;
    projectId: string;
    userId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    outputUrl?: string;
    errorMessage?: string;
    queueMessageId?: string;
    createdAt: Date;
    updatedAt: Date;
  }