import { WebSocketServer, WebSocket } from 'ws';

export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * WebSocket broadcaster mounted at /stream.
 *
 * Dead-client detection uses the standard ping/pong sweep. Note that the sweep
 * must `continue`, not `return`, when it terminates a stale socket -- returning
 * would abandon every remaining client in that pass.
 */
export function initWebSocketServer(
  server,
  {
    path = '/stream',
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    idempotencyEngine = null,
    businessHandler = null,
  } = {},
) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    let pathname = null;
    try {
      pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== path) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', () => ws.terminate());

    // Inbound frames are at-least-once, so route them through the consumer-side
    // idempotency engine when one is supplied; otherwise the socket is
    // broadcast-only.
    if (idempotencyEngine && typeof businessHandler === 'function') {
      ws.on('message', (raw) => {
        idempotencyEngine.processIncoming(ws, raw, businessHandler).catch(() => ws.terminate());
      });
    }
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue; // keep sweeping the remaining clients
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatIntervalMs);

  // Never hold the event loop open just for heartbeats.
  if (typeof interval.unref === 'function') interval.unref();

  wss.on('close', () => clearInterval(interval));

  const broadcast = (payload) => {
    const raw = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
  };

  return { wss, broadcast };
}
