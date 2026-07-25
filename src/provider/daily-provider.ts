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
  // mints a per-user join link so Daily can attribute a session to one of our user ids -- needed
  // for the attendance check below, since the plain room URL is anonymous. baseJoinUrl is the
  // room's own joinUrl from createRoom(), since Daily's subdomain isn't otherwise derivable here
  mintJoinToken(providerRoomId: string, baseJoinUrl: string, userId: string, expiresAt: Date): Promise<string>;
  // sums this user's total session duration in the room, across every join/leave, in seconds
  getAttendedSeconds(providerRoomId: string, userId: string): Promise<number>;
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
          // Version 5: every resolution session is recorded automatically (cloud recording,
          // no manual start/stop) -- Recording Service's retention sweep deletes the recording
          // 15 minutes after the session ends, it's never kept longer than that
          enable_recording: "cloud",
        },
      }),
    });

    if (!res.ok) {
      // include Daily's own error text so failures are debuggable -- never the API key itself
      const body = await res.text().catch(() => "");
      throw new Error(`daily create room failed: ${res.status} ${body}`);
    }

    // Daily's DELETE /v1/rooms/:name endpoint takes the room's *name*, not the `id` field its
    // own create response returns -- storing `json.id` here meant every endRoom() call 404'd
    // ("room '<id>' not found") since that id was never a valid name. We already know the name
    // (we just sent it), so use that as providerRoomId instead of Daily's own id.
    const json = (await res.json()) as { id: string; url: string };
    return { providerRoomId: input.name, joinUrl: json.url };
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

  async mintJoinToken(providerRoomId: string, baseJoinUrl: string, userId: string, expiresAt: Date): Promise<string> {
    const apiKey = process.env.DAILY_API_KEY;
    if (!apiKey) {
      throw new Error("DAILY_API_KEY is not set");
    }

    const res = await fetch(`${DAILY_API_BASE}/meeting-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          room_name: providerRoomId,
          user_id: userId,
          exp: Math.floor(expiresAt.getTime() / 1000),
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`daily mint meeting token failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { token: string };
    return `${baseJoinUrl}?t=${json.token}`;
  }

  async getAttendedSeconds(providerRoomId: string, userId: string): Promise<number> {
    const apiKey = process.env.DAILY_API_KEY;
    if (!apiKey) {
      throw new Error("DAILY_API_KEY is not set");
    }

    const res = await fetch(`${DAILY_API_BASE}/meetings?room=${encodeURIComponent(providerRoomId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`daily get meetings failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as {
      data: { participants: { user_id?: string; duration: number }[] }[];
    };

    return json.data
      .flatMap((session) => session.participants)
      .filter((p) => p.user_id === userId)
      .reduce((total, p) => total + p.duration, 0);
  }
}

// deterministic in-memory fake for tests -- no network call, no real credential needed
export class FakeVideoProvider implements VideoRoomProvider {
  calls: {
    createRoom: CreateRoomInput[];
    endRoom: string[];
    mintJoinToken: { providerRoomId: string; userId: string }[];
  } = { createRoom: [], endRoom: [], mintJoinToken: [] };
  private rooms = new Map<string, string>();
  // test seam: set per (providerRoomId, userId) attendance the fake should report
  attendedSeconds = new Map<string, number>();

  async createRoom(input: CreateRoomInput): Promise<CreateRoomResult> {
    this.calls.createRoom.push(input);
    // providerRoomId is the room *name* here too, matching the real DailyVideoProvider --
    // see the comment there on why this must be the name, not Daily's own internal `id` field
    const providerRoomId = input.name;
    const joinUrl = `https://fake.daily.co/${input.name}`;
    this.rooms.set(providerRoomId, input.name);
    return { providerRoomId, joinUrl };
  }

  async endRoom(providerRoomId: string): Promise<void> {
    this.calls.endRoom.push(providerRoomId);
    this.rooms.delete(providerRoomId);
  }

  async mintJoinToken(providerRoomId: string, baseJoinUrl: string, userId: string): Promise<string> {
    this.calls.mintJoinToken.push({ providerRoomId, userId });
    return `${baseJoinUrl}?t=fake-token-${userId}`;
  }

  async getAttendedSeconds(providerRoomId: string, userId: string): Promise<number> {
    return this.attendedSeconds.get(`${providerRoomId}:${userId}`) ?? 0;
  }
}
