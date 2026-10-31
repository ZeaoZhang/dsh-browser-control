// Minimal RFC 6455 WebSocket server/client transport (no dependencies).
// Only what the plugin needs: one text JSON channel per socket, fragmentation,
// ping/pong and close. Extensions run in Chrome service workers, which connect
// as ordinary WebSocket clients to ws://127.0.0.1:<port>/.

import crypto from 'node:crypto';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function websocketAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return header;
}

export class WebSocketConnection {
  constructor(socket, handlers = {}) {
    this.socket = socket;
    this.handlers = handlers;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.closeSent = false;
    this.closeNotified = false;
    this.lastSeen = Date.now();

    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
    socket.on('end', () => this._onClose());
  }

  get remoteAddress() {
    return this.socket.remoteAddress;
  }

  feed(chunk) {
    this._onData(chunk);
  }

  sendText(text) {
    if (this.closed) return false;
    const payload = Buffer.from(text, 'utf8');
    try {
      return this.socket.write(Buffer.concat([encodeFrame(0x1, payload), payload]));
    } catch {
      this._onClose();
      return false;
    }
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value));
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.closed) return false;
    try {
      return this.socket.write(Buffer.concat([encodeFrame(0x9, payload), payload]));
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      try {
        this.socket.write(Buffer.concat([encodeFrame(0x8, body), body]));
      } catch {
        // fall through to destroy below
      }
    }
    this.closed = true;
    this.socket.destroy();
    this._notifyClose();
  }

  _onData(chunk) {
    if (this.closed) return;
    this.lastSeen = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed && this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this.close(1009, 'too big');
        length = Number(big);
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      if (!this.closeSent) {
        this.closeSent = true;
        try {
          this.socket.write(Buffer.concat([encodeFrame(0x8, payload.subarray(0, 2)), payload.subarray(0, 2)]));
        } catch {
          // ignore
        }
      }
      this.closed = true;
      this.socket.end();
      this._notifyClose();
      return;
    }
    if (opcode === 0x9) {
      try {
        this.socket.write(Buffer.concat([encodeFrame(0xa, payload), payload]));
      } catch {
        this._onClose();
      }
      return;
    }
    if (opcode === 0xa) return;

    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (!fin) return;
      const merged = Buffer.concat(this.fragments);
      const originalOpcode = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = 0;
      this._deliver(originalOpcode, merged);
      return;
    }
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      return;
    }
    this._deliver(opcode, payload);
  }

  _deliver(opcode, payload) {
    if (opcode === 0x1) {
      const text = payload.toString('utf8');
      try {
        this.handlers.onMessage?.(text, this);
      } catch (error) {
        this.handlers.onError?.(error, this);
      }
    } else if (opcode === 0x2) {
      this.handlers.onBinary?.(payload, this);
    }
  }

  _onClose() {
    this._notifyClose();
  }

  // Socket close, error, end, an explicit close() and a close frame can all
  // race. Notify the owner exactly once so the driver never keeps a dead
  // connection in its session table.
  _notifyClose() {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closed = true;
    this.handlers.onClose?.(this);
  }
}

/**
 * Complete the HTTP -> WebSocket upgrade on a raw socket.
 * Returns the connection (already handed `head`) or null when the request is
 * not a valid WebSocket handshake (in which case the socket was destroyed).
 */
export function upgradeToWebSocket(request, socket, head, handlers = {}) {
  const key = request.headers['sec-websocket-key'];
  const version = request.headers['sec-websocket-version'];
  if (!key || version !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    '',
    '',
  ];
  socket.write(lines.join('\r\n'));
  const connection = new WebSocketConnection(socket, handlers);
  if (head && head.length) connection.feed(head);
  return connection;
}
