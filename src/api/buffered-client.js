import { WebSocket } from 'ws';

/**
 * In-memory FIFO buffer for outbound frames. Messages produced while the socket
 * is down are held (up to `maxQueueSize`) and replayed in order on reconnect.
 */
export class BufferedWebSocketClient {
  constructor({
    url,
    reconnectIntervalMs = 50,
    maxQueueSize = 100,
    dropStrategy = 'drop-oldest', // 'drop-oldest' | 'reject-newest'
  } = {}) {
    this.url = url;
    this.reconnectIntervalMs = reconnectIntervalMs;
    this.maxQueueSize = maxQueueSize;
    this.dropStrategy = dropStrategy;

    this.offlineQueue = [];
    this.isManuallyClosed = false;
    this.ws = null;
    this.reconnectTimer = null;

    // Test instrumentation hooks
    this.onOpen = null;
    this.onQueueFlushed = null;
    this.onMessageDropped = null;
  }

  connect() {
    if (this.isManuallyClosed) return;

    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.flushQueue();
      if (this.onOpen) this.onOpen();
    });

    this.ws.on('error', () => {
      // Connection state transition is handled in 'close'
    });

    this.ws.on('close', () => {
      if (this.isManuallyClosed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectIntervalMs);
    });
  }

  send(data) {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data);

    if (this.isOpen()) {
      this.ws.send(serialized);
      return true;
    }

    if (this.offlineQueue.length >= this.maxQueueSize) {
      if (this.dropStrategy === 'drop-oldest') {
        const dropped = this.offlineQueue.shift();
        if (this.onMessageDropped) this.onMessageDropped(dropped);
      } else {
        if (this.onMessageDropped) this.onMessageDropped(serialized);
        return false;
      }
    }

    this.offlineQueue.push(serialized);
    return false; // buffered, not sent immediately
  }

  flushQueue() {
    if (!this.isOpen() || this.offlineQueue.length === 0) return;

    const count = this.offlineQueue.length;
    while (this.offlineQueue.length > 0 && this.isOpen()) {
      const message = this.offlineQueue.shift();
      this.ws.send(message);
    }

    if (this.onQueueFlushed) {
      this.onQueueFlushed(count);
    }
  }

  isOpen() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getQueueSize() {
    return this.offlineQueue.length;
  }

  close() {
    this.isManuallyClosed = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.terminate();
    }
  }
}
