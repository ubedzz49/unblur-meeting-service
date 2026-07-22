import crypto from "node:crypto";

export interface CreateRoomInput {
  name: string;
  expiresAt: Date;
}

export interface CreateRoomResult {
  providerRoomId: string;
  joinUrl: string;
}

// Strategy pattern -- lets a real provider be swapped in (or swapped between Daily/Twilio/Jitsi/
// Zoom) without touching any route handler, same as PaymentGateway in payment-service
export interface VideoRoomProvider {
  createRoom(input: CreateRoomInput): Promise<CreateRoomResult>;
  endRoom(providerRoomId: string): Promise<void>;
}

const DAILY_API_BASE = "https://api.daily.co/v1";

export class DailyVideoProvider implements VideoRoomProvider {
  async createRoom(input: CreateRoomInput): Promise<CreateRoomResult> {
    const apiKey = process.env.DAILY_API_KEY;
    if (!apiKey) {
      throw new Error("DAILY_API_KEY is not set");
    }

    const res = await fetch(`${DAILY_API_BASE}/rooms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: input.name,
        properties: {
          exp: Math.floor(input.expiresAt.getTime() / 1000),
          // recording config (Recording & Moderation Service, Version 5) goes here later --
          // e.g. enable_recording: "cloud" -- deliberately not wired up yet
        },
      }),
    });

    if (!res.ok) {
      // include Daily's own error text so failures are debuggable -- never the API key itself
      const body = await res.text().catch(() => "");
      throw new Error(`daily create room failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { id: string; url: string };
    return { providerRoomId: json.id, joinUrl: json.url };
  }

  async endRoom(providerRoomId: string): Promise<void> {
    const apiKey = process.env.DAILY_API_KEY;
    if (!apiKey) {
      throw new Error("DAILY_API_KEY is not set");
    }

    const res = await fetch(`${DAILY_API_BASE}/rooms/${encodeURIComponent(providerRoomId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`daily end room failed: ${res.status} ${body}`);
    }
  }
}

// deterministic in-memory fake for tests -- no network call, no real credential needed
export class FakeVideoProvider implements VideoRoomProvider {
  calls: { createRoom: CreateRoomInput[]; endRoom: string[] } = { createRoom: [], endRoom: [] };
  private rooms = new Map<string, string>();

  async createRoom(input: CreateRoomInput): Promise<CreateRoomResult> {
    this.calls.createRoom.push(input);
    const providerRoomId = crypto.randomUUID();
    const joinUrl = `https://fake.daily.co/${input.name}`;
    this.rooms.set(providerRoomId, input.name);
    return { providerRoomId, joinUrl };
  }

  async endRoom(providerRoomId: string): Promise<void> {
    this.calls.endRoom.push(providerRoomId);
    this.rooms.delete(providerRoomId);
  }
}
