import { NextResponse } from "next/server";
import { getStore } from "@/lib/store.ts";
import { ingestReadings, MAX_BATCH } from "@/lib/ingest.ts";

export const runtime = "nodejs";

/**
 * Submit signed readings.
 * Body: a single reading object, an array of readings, or { "readings": [...] }.
 * Each item is checked on its own, and the response lists a result per item so a
 * device can retry only what failed.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let items: unknown[];
  if (Array.isArray(body)) items = body;
  else if (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { readings?: unknown }).readings)
  ) {
    items = (body as { readings: unknown[] }).readings;
  } else items = [body];

  if (items.length === 0) {
    return NextResponse.json({ error: "no readings" }, { status: 400 });
  }
  if (items.length > MAX_BATCH) {
    return NextResponse.json({ error: `max ${MAX_BATCH} readings per request` }, { status: 413 });
  }

  const results = await ingestReadings(getStore(), items);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return NextResponse.json({
    accepted: count("accepted"),
    duplicate: count("duplicate"),
    rejected: count("rejected"),
    results,
  });
}

/** List stored readings for a parcel, oldest first. Empty list when there are none. */
export async function GET(req: Request) {
  const parcelId = new URL(req.url).searchParams.get("parcelId");
  if (!parcelId || !/^[A-Za-z0-9_-]{1,64}$/.test(parcelId)) {
    return NextResponse.json({ error: "invalid parcelId" }, { status: 400 });
  }
  const readings = await getStore().listReadings(parcelId);
  return NextResponse.json({ parcelId, count: readings.length, readings });
}
