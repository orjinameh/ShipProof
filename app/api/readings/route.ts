import { handleApi } from "@/lib/api.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ingest and listing logic lives in lib/api.ts, with the rest of the API.
export const POST = (req: Request) => handleApi(req);
export const GET = (req: Request) => handleApi(req);
