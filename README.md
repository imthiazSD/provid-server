# Video Editing Backend API

A comprehensive Express.js backend for a video editing web application with MongoDB, AWS S3, and SQS integration.

## Features

- **User Authentication**: JWT-based signup/signin
- **Project Management**: CRUD operations for video editing projects
- **File Upload**: Video and thumbnail upload to AWS S3
- **Video Export**: Queue-based video rendering with Remotion Lambda
- **Autosave**: Real-time project saving
- **Real-time Collaboration**: WebSocket integration
- **Fault Tolerance**: Comprehensive error handling and logging
- **Scalability**: Modular architecture with service layer

## Quick Start

### Prerequisites
- Node.js 18+
- MongoDB 6.0+
- AWS Account (S3, SQS)
- Redis (optional, for caching)

### Environment Setup
```bash
cp .env.example .env
# Edit .env with your configuration
```

### Installation
```bash
npm install
npm run build
npm start

# Development mode
npm run dev
```

### Docker Setup
```bash
docker-compose up -d
```

## API Endpoints

### Authentication
- `POST /api/auth/signup` - User registration
- `POST /api/auth/signin` - User login
- `GET /api/auth/profile` - Get user profile

### Projects
- `GET /api/projects` - List user projects
- `POST /api/projects` - Create new project
- `GET /api/projects/:id` - Get project details
- `PUT /api/projects/:id` - Update project
- `POST /api/projects/:id/autosave` - Autosave project
- `DELETE /api/projects/:id` - Delete project

### File Upload
- `POST /api/upload/:projectId/video` - Upload video file
- `POST /api/upload/:projectId/thumbnail` - Upload thumbnail

### Export
- `POST /api/export/:projectId/export` - Queue video export
- `GET /api/export/:exportId/status` - Get export status
- `GET /api/export/history` - Get export history
- `POST /api/export/webhook/status` - Webhook for Lambda updates

## License

This project is licensed under the MIT License.