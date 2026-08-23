export enum Priority {
    High = 0,
    Medium = 1,
    Low = 2
}

export class Packet {
    constructor(
        public size: number,
        public priority: Priority,
        public enqueueTime: number = Date.now(),
        public isEcnMarked: boolean = false
    ) {}
}

export class DeficitRoundRobin {
    private readonly quantum = 1500;
    private deficits: Map<Priority, number> = new Map();
    private queues: Map<Priority, Packet[]> = new Map();
    private currentClassIndex: number = 0;

    constructor() {
        this.deficits.set(Priority.High, 0);
        this.deficits.set(Priority.Medium, 0);
        this.deficits.set(Priority.Low, 0);

        this.queues.set(Priority.High, []);
        this.queues.set(Priority.Medium, []);
        this.queues.set(Priority.Low, []);
    }

    enqueue(packet: Packet) {
        this.queues.get(packet.priority)!.push(packet);
    }

    dequeue(): Packet | null {
        const priorities = [Priority.High, Priority.Medium, Priority.Low];
        let classesChecked = 0;

        while (classesChecked < priorities.length) {
            const p = priorities[this.currentClassIndex];
            const queue = this.queues.get(p)!;

            if (queue.length > 0) {
                let currentDeficit = this.deficits.get(p)!;
                if (currentDeficit < queue[0].size) {
                    const multiplier = p === Priority.High ? 5 : 1;
                    currentDeficit += this.quantum * multiplier;
                    this.deficits.set(p, currentDeficit);
                }

                if (currentDeficit >= queue[0].size) {
                    const packet = queue.shift()!;
                    this.deficits.set(p, currentDeficit - packet.size);
                    return packet;
                }
            } else {
                this.deficits.set(p, 0);
            }

            this.currentClassIndex = (this.currentClassIndex + 1) % priorities.length;
            classesChecked++;
        }

        return null;
    }
}
