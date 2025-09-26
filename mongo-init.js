// MongoDB initialization script
db.createUser({
    user: 'apiuser',
    pwd: 'apipassword',
    roles: [
      {
        role: 'readWrite',
        db: 'video-editor'
      }
    ]
  });
  
  // Create indexes for better performance
  db.users.createIndex({ "email": 1 }, { unique: true });
  db.projects.createIndex({ "userId": 1, "createdAt": -1 });
  db.projects.createIndex({ "userId": 1, "updatedAt": -1 });
  db.exportrequests.createIndex({ "userId": 1, "createdAt": -1 });
  db.exportrequests.createIndex({ "status": 1, "createdAt": -1 });
  db.exportrequests.createIndex({ "projectId": 1, "userId": 1 });