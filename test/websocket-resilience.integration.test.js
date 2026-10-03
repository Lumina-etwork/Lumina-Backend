import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

describe('WebSocket Resilience: Heartbeats & Client Reconnection', () => {
  let httpServer;
  let wss;
  let serverPort;
  let heartbeatIntervalTimer;
  const HEARTBEAT_INTERVAL_MS = 60; // fast interval for testing
  const activeSockets = new Set();

  before(async () => {
    httpServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === '/stream') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on('connection', (ws) => {
      ws.isAlive = true;
      activeSockets.add(ws);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('close', () => {
        activeSockets.delete(ws);
      });
    });

    // Server-side heartbeat monitor: sweeps every interval.
    heartbeatIntervalTimer = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          // Client failed to answer the previous ping. `continue`, never
          // `return` -- returning would abandon every remaining client.
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);

    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    serverPort = httpServer.address().port;
  });

  after(async () => {
    clearInterval(heartbeatIntervalTimer);
    for (const ws of activeSockets) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  });

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  it('terminates unresponsive zombie sockets when pong is not returned', async () => {
    const zombieClient = new WebSocket(`ws://127.0.0.1:${serverPort}/stream`);
    await new Promise((resolve) => zombieClient.once('open', resolve));

    // Suppress outbound pong frames to simulate a half-open TCP connection.
    zombieClient.pong = () => {};
    if (zombieClient._sender) zombieClient._sender.pong = () => {};

    const terminationPromise = new Promise((resolve) => {
      zombieClient.once('close', (code) => resolve(code));
    });

    // Two sweeps: the first marks isAlive=false, the second terminates.
    const closeCode = await Promise.race([
      terminationPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('server failed to terminate unresponsive socket')), 1500),
      ),
    ]);

    assert.notEqual(closeCode, undefined);
    assert.equal(zombieClient.readyState, WebSocket.CLOSED);
  });

  it('keeps active sockets connected across multiple ping/pong cycles', async () => {
    const healthyClient = new WebSocket(`ws://127.0.0.1:${serverPort}/stream`);
    await new Promise((resolve) => healthyClient.once('open', resolve));

    let pingCount = 0;
    healthyClient.on('ping', () => {
      pingCount += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_INTERVAL_MS * 3 + 40));

    assert.ok(pingCount >= 2, `expected at least 2 ping frames, received ${pingCount}`);
    assert.equal(healthyClient.readyState, WebSocket.OPEN);

    healthyClient.close();
  });

  it('reconnects after a server-side drop and continues receiving broadcasts', async () => {
    class LuminaStreamClient {
      constructor(url, reconnectIntervalMs = 50) {
        this.url = url;
        this.reconnectIntervalMs = reconnectIntervalMs;
        this.messages = [];
        this.reconnectCount = 0;
        this.isClosedManually = false;
        this.connect();
      }

      connect() {
        this.ws = new WebSocket(this.url);
        this.ws.on('open', () => this.onOpen?.());
        this.ws.on('message', (raw) => {
          const parsed = JSON.parse(raw.toString());
          this.messages.push(parsed);
          this.onMessage?.(parsed);
        });
        this.ws.on('close', () => {
          if (!this.isClosedManually) {
            this.reconnectCount += 1;
            setTimeout(() => this.connect(), this.reconnectIntervalMs);
          }
        });
      }

      close() {
        this.isClosedManually = true;
        this.ws.close();
      }
    }

    const client = new LuminaStreamClient(`ws://127.0.0.1:${serverPort}/stream`, 40);

    await new Promise((resolve) => {
      client.onOpen = resolve;
    });

    broadcast({ type: 'IP_ANCHOR', data: { asset_id: 1 } });
    await new Promise((resolve) => {
      client.onMessage = resolve;
    });
    assert.equal(client.messages.length, 1);

    // Drop this client's server-side connection.
    const serverConnection = [...wss.clients].find(
      (ws) => ws.readyState === WebSocket.OPEN,
    );
    assert.ok(serverConnection, 'an active server socket must exist');

    const reconnectedPromise = new Promise((resolve) => {
      client.onOpen = resolve;
    });

    serverConnection.terminate();
    await reconnectedPromise;
    assert.ok(client.reconnectCount >= 1, 'client should have reconnected at least once');

    const secondMessagePromise = new Promise((resolve) => {
      client.onMessage = (msg) => {
        if (msg.data?.asset_id === 2) resolve(msg);
      };
    });

    broadcast({ type: 'IP_ANCHOR', data: { asset_id: 2 } });
    const secondMsg = await secondMessagePromise;
    assert.equal(secondMsg.data.asset_id, 2);
    assert.equal(client.messages.length, 2);

    client.close();
  });
});
