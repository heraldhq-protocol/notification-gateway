module.exports = {
  apps: [
    {
      name: 'herald-gateway',
      script: 'pnpm',
      args: 'run start:prod',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        NITRO_ENCLAVE_SOCKET: './socket.sock',
        NODE_OPTIONS: '--max-old-space-size=450',
      },
    },
    {
      name: 'mock-enclave',
      script: 'docker/mock-enclave.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        NITRO_ENCLAVE_SOCKET: './socket.sock',
      },
    },
  ],
};
