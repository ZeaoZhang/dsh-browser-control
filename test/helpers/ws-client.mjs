// Tiny RFC 6455 client used by the tests to emulate the Chrome extension.
import net from 'node:net';
import crypto from 'node:crypto';

export class TestWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.handlers = { message: () => {}, close: () => {} };
    socket.on('data', (chunk) => this._data(chunk));
    socket.on('close', () => { this.closed = true; this.handlers.close(); });
    socket.on('error', () => { this.closed = true; });
  }

  static connect(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host, () => {
        const key = crypto.randomBytes(16).toString('base64');
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
        let head = Buffer.alloc(0);
        const onData = (chunk) => {
          head = Buffer.concat([head, chunk]);
          const end = head.indexOf('\r\n\r\n');
          if (end < 0) return;
          socket.off('data', onData);
          const response = head.subarray(0, end).toString();
          if (!response.startsWith('HTTP/1.1 101')) {
            reject(new Error(`handshake failed: ${response}`));
            socket.destroy();
            return;
          }
          const ws = new TestWebSocket(socket);
          const rest = head.subarray(end + 4);
          if (rest.length) ws._data(rest);
          resolve(ws);
        };
        socket.on('data', onData);
      });
      socket.once('error', reject);
    });
  }

  send(value) {
    const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  _data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const opcode = first & 0x0f;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1) this.handlers.message(payload.toString('utf8'));
      else if (opcode === 0x8) { this.closed = true; this.socket.end(); }
    }
  }

  close() {
    this.closed = true;
    this.socket.destroy();
  }
}
