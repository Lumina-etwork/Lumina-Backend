use std::time::Instant;
use std::collections::HashMap;

const SHAPE_CLASS_RATE: u64 = 1_000_000_000; // 1 Gbps in bits per second
const MAX_BULK_FLOW_RATE: u64 = (SHAPE_CLASS_RATE * 40) / 100; // 40% of 1 Gbps

pub struct LeakyBucket {
    capacity: u64,
    tokens: u64,
    last_update: Instant,
    fill_rate: u64, // bits per second
}

impl LeakyBucket {
    pub fn new(capacity: u64, fill_rate: u64) -> Self {
        LeakyBucket {
            capacity,
            tokens: capacity,
            last_update: Instant::now(),
            fill_rate,
        }
    }

    pub fn consume(&mut self, bits: u64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_update).as_secs_f64();
        
        // Refill tokens
        let added_tokens = (elapsed * self.fill_rate as f64) as u64;
        self.tokens = std::cmp::min(self.capacity, self.tokens + added_tokens);
        self.last_update = now;

        if self.tokens >= bits {
            self.tokens -= bits;
            true
        } else {
            false
        }
    }
}

pub struct TrafficShaper {
    bulk_flows: HashMap<String, LeakyBucket>,
    congestion: bool,
}

impl TrafficShaper {
    pub fn new() -> Self {
        TrafficShaper {
            bulk_flows: HashMap::new(),
            congestion: false,
        }
    }

    pub fn set_congestion(&mut self, congestion: bool) {
        self.congestion = congestion;
    }

    pub fn can_transmit(&mut self, flow_id: &str, is_bulk: bool, size_bytes: usize) -> bool {
        if is_bulk && self.congestion {
            let size_bits = (size_bytes * 8) as u64;
            let bucket = self.bulk_flows.entry(flow_id.to_string()).or_insert_with(|| {
                // Capacity to handle 10x MTU burst (1500 bytes * 10 * 8 = 120000 bits)
                LeakyBucket::new(120_000, MAX_BULK_FLOW_RATE)
            });
            bucket.consume(size_bits)
        } else {
            true
        }
    }
}
