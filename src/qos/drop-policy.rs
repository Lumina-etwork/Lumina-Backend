use crate::qos::class_queue::{Packet, Priority}; // Assume this module structure

const MAX_QUEUED_BYTES: usize = 64 * 1024 * 1024; // 64 MB
const ECN_THRESHOLD: usize = (MAX_QUEUED_BYTES * 80) / 100; // 80% of 64MB

pub struct DropPolicy {
    current_queued_bytes: usize,
    dropped_packets_count: usize,
}

impl DropPolicy {
    pub fn new() -> Self {
        DropPolicy {
            current_queued_bytes: 0,
            dropped_packets_count: 0,
        }
    }

    pub fn process_packet(&mut self, mut packet: Packet, priority: Priority) -> Option<Packet> {
        // Tail-drop if queue is full
        if self.current_queued_bytes + packet.size > MAX_QUEUED_BYTES {
            self.dropped_packets_count += 1;
            return None; // Drop packet
        }

        // ECN Marking for Low Priority packets when queue depth > 80%
        if priority == Priority::Low && self.current_queued_bytes >= ECN_THRESHOLD {
            // Apply CE (Congestion Experienced) codepoint logic here
            // We represent this by setting a flag on the packet (assuming it exists in Packet struct)
            // packet.is_ecn_marked = true;
            // For now, we simulate this by returning the modified packet.
        }

        self.current_queued_bytes += packet.size;
        Some(packet)
    }
    
    pub fn packet_dequeued(&mut self, size: usize) {
        if self.current_queued_bytes >= size {
            self.current_queued_bytes -= size;
        } else {
            self.current_queued_bytes = 0;
        }
    }
    
    pub fn get_dropped_count(&self) -> usize {
        self.dropped_packets_count
    }
}
