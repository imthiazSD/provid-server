export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503
};

export const FILE_TYPES = {
  VIDEO: ['video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/webm'],
  IMAGE: ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
};

export const MAX_FILE_SIZE = {
  VIDEO: 500 * 1024 * 1024, // 500MB
  IMAGE: 10 * 1024 * 1024   // 10MB
};

export const EXPORT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

export const LAYER_TYPES = {
  HIGHLIGHT: 'highlight',
  ZOOM: 'zoom',
  BLUR: 'blur'
};