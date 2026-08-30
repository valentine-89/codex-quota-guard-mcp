import { randomUUID } from "node:crypto";

export interface ClientLeaseSnapshot {
  liveClients: number;
  nextExpiryAtMs: number | null;
}

/** In-memory connector ownership only; no Codex PID discovery or durable client state. */
export class ClientLeaseRegistry {
  private readonly clients = new Map<string, number>();

  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000) throw new Error("CLIENT_LEASE_TTL_INVALID");
  }

  register(): string {
    this.expire();
    const id = randomUUID();
    this.clients.set(id, this.now() + this.ttlMs);
    return id;
  }

  renew(id: string): boolean {
    this.expire();
    if (!this.clients.has(id)) return false;
    this.clients.set(id, this.now() + this.ttlMs);
    return true;
  }

  unregister(id: string): boolean { return this.clients.delete(id); }

  expire(): number {
    const now = this.now();
    let expired = 0;
    for (const [id, deadline] of this.clients) {
      if (deadline <= now) { this.clients.delete(id); expired++; }
    }
    return expired;
  }

  snapshot(): ClientLeaseSnapshot {
    this.expire();
    const deadlines = [...this.clients.values()];
    return { liveClients: deadlines.length, nextExpiryAtMs: deadlines.length ? Math.min(...deadlines) : null };
  }
}
