/**
 * src/ws/index.ts
 *
 * Barrel export for the WebSocket connection management module.
 * Fix for Issue #3: WebSocket Connection Pool Exhaustion Under
 * Concurrent Disconnect/Reconnect Storm.
 */

export {
  ConnectionManager,
  DuplicateConnectionError,
  StaleGenerationError,
  RECONNECT_GRACE_MS,
} from './connectionManager';

export {
  ConnectionPool,
  PoolCapacityError,
  MAX_POOL_CAPACITY,
} from './pool';

export type {
  ConnectionEntry,
  ConnectionState,
  WebSocketLike,
  NodeConnectionOptions,
  ConnectionManagerOptions,
} from './connectionManager';
