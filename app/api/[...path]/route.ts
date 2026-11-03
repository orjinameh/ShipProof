import { handleApi } from "@/lib/api.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The investigator waits on a model, which can take a while.
export const maxDuration = 60;

const run = (req: Request) => handleApi(req);

export const GET = run;
export const POST = run;
