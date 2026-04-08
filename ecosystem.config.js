module.exports = {
  apps: [
    {
      name: 'herald-gateway',
      script: 'dist/main.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'mock-enclave',
      script: 'docker/mock-enclave.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NITRO_ENCLAVE_SOCKET: '/run/enclave.sock',
      },
    },
  ],
};
