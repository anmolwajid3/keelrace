// Supports the Team tab's invite flow now that `profiles` is no longer
// globally readable (migration 0005). This intentionally returns the
// minimum needed to invite someone: their id and display name, looked up by
// an EXACT email match only -- no partial search, no listing, so it can't
// be used to enumerate users the way a broad SELECT on profiles could.
import { corsHeaders, errorResponse, json, serviceClient, userClient } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { email } = await req.json();
    if (!email) return errorResponse("email is required");

    // Require the caller to be authenticated at all (even though the
    // service client below bypasses RLS) -- this endpoint should never be
    // reachable anonymously.
    const caller = userClient(req);
    const { data: userData } = await caller.auth.getUser();
    if (!userData?.user) return errorResponse("unauthenticated", 401);

    const supabase = serviceClient();
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .eq("email", email.trim())
      .maybeSingle();
    if (error) throw error;
    if (!profile) return errorResponse("No KeelRace account found with that email", 404);

    return json({ id: profile.id, full_name: profile.full_name, email: profile.email });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
