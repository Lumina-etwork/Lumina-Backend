use std::collections::HashMap;

pub struct Connection {
    pub id: usize,
    pub active_streams: usize,
    pub max_streams: usize,
}

pub struct ConnectionMultiplexer {
    pub min_pool_size: usize,
    pub max_pool_size: usize,
    pub max_concurrent_streams: usize,
    pub connections: HashMap<String, Vec<Connection>>,
}

impl ConnectionMultiplexer {
    pub fn new() -> Self {
        Self {
            min_pool_size: 50,
            max_pool_size: 500,
            max_concurrent_streams: 1000,
            connections: HashMap::new(),
        }
    }

    pub fn get_connection(&mut self, host: &str) -> Option<&Connection> {
        let pool = self.connections.get_mut(host)?;
        for conn in pool.iter() {
            if conn.active_streams < conn.max_streams {
                return Some(conn);
            }
        }
        if pool.len() < self.max_pool_size {
            let id = pool.len();
            pool.push(Connection {
                id,
                active_streams: 0,
                max_streams: self.max_concurrent_streams,
            });
            pool.last()
        } else {
            pool.iter().min_by_key(|c| c.active_streams)
        }
    }

    pub fn open_stream(&mut self, host: &str) -> Option<(usize, usize)> {
        let conn = self.get_connection(host)?;
        conn.active_streams += 1;
        Some((conn.id, conn.active_streams))
    }

    pub fn close_stream(&mut self, host: &str, conn_id: usize) {
        if let Some(pool) = self.connections.get_mut(host) {
            if let Some(conn) = pool.iter_mut().find(|c| c.id == conn_id) {
                conn.active_streams = conn.active_streams.saturating_sub(1);
            }
        }
    }
}
