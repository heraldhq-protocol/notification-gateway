const net = require('net');
const fs = require('fs');
const path = require('path');

/**
 * Mock Nitro Enclave Socket Server
 * 
 * This script simulates the Unix socket interface of an AWS Nitro Enclave.
 * It follows the JSON-based protocol used by the Herald Notification Gateway.
 * 
 * Architectural Pattern:
 * Gateway (Client) -> UNIX Socket (/run/enclave.sock) -> This Script (Server)
 */

const SOCKET_PATH = process.env.NITRO_ENCLAVE_SOCKET || '/run/enclave.sock';

// Cleanup existing socket if it exists
if (fs.existsSync(SOCKET_PATH)) {
  fs.unlinkSync(SOCKET_PATH);
}

const server = net.createServer((socket) => {
  console.log('Client connected to mock enclave');

  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();

    // The Gateway sends JSON followed by a newline or '}'
    if (buffer.endsWith('\n') || buffer.endsWith('}')) {
      try {
        const request = JSON.parse(buffer.trim());
        console.log('Received request:', request.op);

        if (request.op === 'decrypt') {
          // SEC-MOCK: In a real enclave, this would use AWS KMS and NaCl
          // For the $0 budget setup, we return a deterministic test email
          const response = {
            email: `mock-decrypted-${request.owner_pubkey.slice(0, 8)}@useherald.xyz`,
          };

          socket.write(JSON.stringify(response) + '\n');
        } else {
          socket.write(JSON.stringify({ error: 'UNKNOWN_OPERATION' }) + '\n');
        }
      } catch (err) {
        console.error('Failed to parse request:', err.message);
      }
      buffer = '';
    }
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
  });

  socket.on('end', () => {
    console.log('Client disconnected');
  });
});

server.listen(SOCKET_PATH, () => {
  console.log(`Mock Enclave listening on ${SOCKET_PATH}`);
  // Ensure the socket is world-writable so the Gateway container can access it
  fs.chmodSync(SOCKET_PATH, '666');
});

// Handle termination
process.on('SIGINT', () => {
  server.close();
  process.exit();
});

process.on('SIGTERM', () => {
  server.close();
  process.exit();
});
