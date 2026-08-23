use std::time::{Duration, Instant};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    High,
    Medium,
    Low,
}

pub struct Packet {
    pub size: usize,
    pub priority: Priority,
    pub enqueue_time: Instant,
}

pub struct ClassQueue {
    queue: VecDeque<Packet>,
    priority: Priority,
    strict_priority_mode: bool,
}

impl ClassQueue {
    pub fn new(priority: Priority) -> Self {
        ClassQueue {
            queue: VecDeque::new(),
            priority,
            strict_priority_mode: false,
        }
    }

    pub fn enqueue(&mut self, packet: Packet) {
        self.queue.push_back(packet);
    }

    pub fn dequeue(&mut self) -> Option<Packet> {
        self.queue.pop_front()
    }

    pub fn peek(&self) -> Option<&Packet> {
        self.queue.front()
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn check_starvation(&mut self) {
        if self.priority == Priority::High {
            if let Some(front_packet) = self.queue.front() {
                if front_packet.enqueue_time.elapsed() > Duration::from_millis(10) {
                    self.strict_priority_mode = true;
                } else {
                    self.strict_priority_mode = false;
                }
            } else {
                self.strict_priority_mode = false;
            }
        }
    }
    
    pub fn is_strict_priority_mode(&self) -> bool {
        self.strict_priority_mode
    }
}
