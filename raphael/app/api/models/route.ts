import { getModels } from "@/lib/ai/models";

export const runtime = "nodejs";

/**
 * GET /api/models
 *
 * Returns the Ryzumi model catalog with availability for the model selector.
 * Never includes credentials or raw upstream error bodies.
 *
 * Query params:
 *   ?refresh=1  force a fresh fetch from the Ryzumi /models endpoint
 *               (bypasses the short server-side cache)
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";

  try {
    const result = await getModels({ refresh });
    return Response.json(
      {
        models: result.models,
        source: result.source,
        refreshedAt: result.refreshedAt,
      },
      {
        headers: {
          "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
          "X-Content-Type-Options": "nosniff",
        },
      }
    );
  } catch {
    return Response.json(
      { error: "Could not load the model list." },
      { status: 500 }
    );
  }
}
