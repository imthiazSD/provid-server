module.exports = {
    apps: [{
      name: 'video-editing-api',
      script: 'dist/app.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development',
        PORT: 5000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      max_memory_restart: '1G',
      node_args: '--max-old-space-size=1024',
      watch: false,
      ignore_watch: ['node_modules', 'logs'],
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 8000
    }],
  
    deploy: {
      production: {
        user: 'deploy',
        host: 'your-server.com',
        ref: 'origin/main',
        repo: 'git@github.com:yourusername/video-editing-backend.git',
        path: '/var/www/video-editing-api',
        'pre-deploy-local': '',
        'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
        'pre-setup': ''
      }
    }
  };