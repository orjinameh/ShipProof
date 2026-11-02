import { NextResponse } from "next/server";
import { getStore } from "@/lib/store.ts";
import { publicKeyFromRaw } from "@/lib/verify.ts";

export const runtime = "nodejs";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Register a device's public key.
 * Body: { "deviceId": "tag-001", "publicKey": "<base64 of 65-byte uncompressed P-256 point>" }
 *
 * NOTE: registration is open for now (no account system yet). A device ID that is
 * already registered with a different key is refused, so keys cannot be swapped.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { deviceId, publicKey } = (body ?? {}) as Record<string, unknown>;
  if (typeof deviceId !== "string" || !ID_RE.test(deviceId)) {
    return NextResponse.json({ error: "invalid deviceId" }, { status: 400 });
  }
  if (typeof publicKey !== "string") {
    return NextResponse.json({ error: "invalid publicKey" }, { status: 400 });
  }
  try {
    publicKeyFromRaw(publicKey);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const store = getStore();
  const existing = await store.getDevice(deviceId);
  if (existing) {
    if (existing.publicKey === publicKey) {
      return NextResponse.json({ deviceId, status: "already-registered" });
    }
    return NextResponse.json(
      { error: "deviceId already registered with a different key" },
      { status: 409 },
    );
  }
  await store.putDevice({
    deviceId,
    publicKey,
    registeredAt: Math.floor(Date.now() / 1000),
  });
  return NextResponse.json({ deviceId, status: "registered" }, { status: 201 });
}
