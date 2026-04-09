export const apps = [
  {
    name: 'herald-gateway',
    script: 'pnpm',
    args: 'run start:prod',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      NITRO_ENCLAVE_SOCKET: '/home/ec2-user/notification-gateway/socket.sock',
    },
  },
  {
    name: 'mock-enclave',
    script: 'docker/mock-enclave.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NITRO_ENCLAVE_SOCKET: '/home/ec2-user/notification-gateway/socket.sock',
    },
  },
];
