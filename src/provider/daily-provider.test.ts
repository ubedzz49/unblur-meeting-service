import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyVideoProvider } from "./daily-provider.js";

// regression: createRoom used to return Daily's own `id` field as providerRoomId, but Daily's
// DELETE /v1/rooms/:name endpoint takes the room's *name*, not that id -- every real endRoom()
// call silently 404'd ("room '<id>' not found") in production because of this mismatch. Caught
// live (a real room created via /internal/rooms was confirmed via Daily's own API to still exist
// after a "successful" /internal/rooms/:id/end call). No test had ever exercised
// DailyVideoProvider directly against a mocked fetch -- FakeVideoProvider hid the bug entirely.
describe("DailyVideoProvider", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.DAILY_API_KEY;

  beforeEach(() => {
    process.env.DAILY_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.DAILY_API_KEY = originalKey;
  });

  it("returns the room's name as providerRoomId, not Daily's own internal id", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "daily-internal-uuid-not-a-name", url: "https://unblur.daily.co/my-room-name" }),
    }) as unknown as typeof fetch;

    const provider = new DailyVideoProvider();
    const result = await provider.createRoom({ name: "my-room-name", expiresAt: new Date(Date.now() + 60000) });

    expect(result.providerRoomId).toBe("my-room-name");
    expect(result.providerRoomId).not.toBe("daily-internal-uuid-not-a-name");
    expect(result.joinUrl).toBe("https://unblur.daily.co/my-room-name");
  });

  it("endRoom calls DELETE on the room name (the providerRoomId createRoom returned)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new DailyVideoProvider();
    await provider.endRoom("my-room-name");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.daily.co/v1/rooms/my-room-name",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("createRoom throws with Daily's error body on a non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid-request"}',
    }) as unknown as typeof fetch;

    const provider = new DailyVideoProvider();
    await expect(provider.createRoom({ name: "x", expiresAt: new Date() })).rejects.toThrow(
      /daily create room failed: 400/,
    );
  });

  it("endRoom throws with Daily's error body on a non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"error":"not-found"}',
    }) as unknown as typeof fetch;

    const provider = new DailyVideoProvider();
    await expect(provider.endRoom("gone-room")).rejects.toThrow(/daily end room failed: 404/);
  });

  it("throws clearly if DAILY_API_KEY is unset", async () => {
    delete process.env.DAILY_API_KEY;
    const provider = new DailyVideoProvider();
    await expect(provider.createRoom({ name: "x", expiresAt: new Date() })).rejects.toThrow(/DAILY_API_KEY/);
  });
});
