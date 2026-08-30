-- ============================================================================
-- Migration: 20260101000028_word_cloud_moderation_rpc.sql
-- Purpose:   Implement the admin-only word-cloud entry hide/unhide moderation
--            RPC and the best-effort visible-aggregate Realtime Broadcast for
--            MSS LivePulse Milestone 3 (Polls & Word Cloud, Task 22.4).
--
--            This migration adds:
--              * broadcast_word_cloud(p_event_id, p_prompt_id) — an internal,
--                best-effort Realtime fan-out helper modelled EXACTLY on
--                broadcast_vote_count (…000016_vote_broadcast.sql), and
--              * set_word_cloud_response_hidden(p_response_id, p_is_hidden) —
--                the admin-only SECURITY DEFINER RPC that flips a
--                word_cloud_responses.is_hidden flag (Req 6.12), audits the
--                moderation change (change_type='moderation', Req 21.19), and
--                broadcasts the recomputed VISIBLE word-cloud aggregate for the
--                affected prompt (Req 6.15).
--
-- Ordering: this migration uses the …000028 timestamp so it sorts AFTER the
--   last word-cloud migration on disk (…000026_word_cloud_respond_rpc.sql). It
--   depends on the following already existing:
--     * …000019 word_cloud          (word_cloud_prompts / word_cloud_responses,
--                                    incl. word_cloud_responses.is_hidden),
--     * …000004 audit_log           (audit_log.change_type — the CHECK allows
--                                    'moderation'; audit_log.event_id;
--                                    occurred_at DEFAULT now()),
--   and on Supabase's built-in `realtime` schema (`realtime.send`), which is
--   provided by the Supabase platform's Realtime extension.
--
-- ----------------------------------------------------------------------------
-- Word-cloud moderation model (Req 6.12, 6.13, 6.15)
-- ----------------------------------------------------------------------------
--   Individual word-cloud submissions can be hidden (or unhidden) by an
--   administrator. Hiding a response sets word_cloud_responses.is_hidden = true;
--   hidden entries are excluded from the aggregate (Req 6.13). Moderation is a
--   privileged, server-mediated write — word_cloud_responses has NO client
--   UPDATE policy under RLS (…000022_word_cloud_rls.sql); this SECURITY DEFINER
--   RPC is the authoritative hide/unhide path.
--
--   After the visibility flag changes, the recomputed VISIBLE aggregate is
--   pushed to connected clients via Supabase Realtime Broadcast so the word
--   cloud updates when an entry's visibility changes (Req 6.15), within the
--   2-second delivery target (Req 23.1) on a narrow, event-scoped topic
--   (Req 23.2).
--
-- ----------------------------------------------------------------------------
-- Channel / topic naming and payload shape (client contract)
-- ----------------------------------------------------------------------------
--   Topic (per EVENT, narrow scope — Req 23.2):
--       'event:{event_id}:wordcloud'
--   Event name (snake_case entity_action):
--       'word_cloud'
--   Payload (jsonb) — EVENT-SCOPED, PRIVACY-SAFE (Req 20 privacy / 8.6, 8.20):
--       {
--         "event_id":  "<uuid>",
--         "prompt_id": "<uuid>",
--         "terms": [ { "term": "<normalised_text>", "frequency": <int> }, ... ]
--       }
--   The payload carries ONLY the aggregate visible term/frequency pairs and the
--   ids needed to route it. It MUST NOT contain participant_identifier or any
--   per-participant / personal data (Req 8.6, 8.20). Individual response rows
--   remain unreadable by clients under RLS; only the aggregate is broadcast.
--
--   RAW visible aggregate — client-side finishing: the broadcast payload carries
--   the RAW visible (normalised_text, count) pairs GROUPed straight from the
--   table. Stop-word EXCLUSION (Req 6.11/6.14) and monotonic term sizing are
--   applied CLIENT-SIDE by aggregateWordCloud() in src/lib/wordcloud.ts. We do
--   NOT attempt stop-word filtering in SQL for M3 — the SQL side is deliberately
--   just "visible rows grouped by normalised_text".
--
--   `realtime.send(...)` uses `private => false`: the broadcast carries only a
--   public aggregate (no PII), matching broadcast_vote_count.
--
-- ----------------------------------------------------------------------------
-- Best-effort semantics (broadcast MUST NOT break moderation)
-- ----------------------------------------------------------------------------
--   The broadcast is a best-effort fan-out layered on top of the authoritative
--   is_hidden write + audit row. broadcast_word_cloud wraps the realtime.send
--   call in a BEGIN/EXCEPTION WHEN OTHERS block that swallows (and RAISEs a
--   WARNING for) any error, so a Realtime hiccup can NEVER roll back or fail the
--   enclosing moderation transaction — EXACTLY like broadcast_vote_count.
--   Clients that miss a broadcast still converge on the correct visible cloud
--   via their next read.
--
-- ----------------------------------------------------------------------------
-- Admin authorisation
-- ----------------------------------------------------------------------------
--   set_word_cloud_response_hidden is GRANTed EXECUTE to `authenticated` ONLY
--   (NOT anon): moderation is an admin action. For V1, any authenticated user
--   is an admin (Req 10.3). broadcast_word_cloud is an INTERNAL helper reached
--   only through the SECURITY DEFINER RPC (with definer rights); it is
--   intentionally NOT granted to anon or authenticated.
--
-- Both functions are SECURITY DEFINER with a locked search_path (public,
-- pg_temp) so they cannot be hijacked via a caller-controlled search_path.
-- `realtime.send` is schema-qualified so the locked search_path does not hide
-- it.
--
-- ----------------------------------------------------------------------------
-- Error signals (set_word_cloud_response_hidden)
-- ----------------------------------------------------------------------------
--   response_not_found — no word_cloud_responses row matches p_response_id
--                        (RAISEd with SQLSTATE P0001).
--
-- Requirements traceability: 6.12, 6.13, 6.15, 7.9, 23.1, 23.2
--   (and privacy: Req 8.6, 8.20; audit: Req 21.19; admin: Req 10.3).
-- Design ref: Request/data flows → Word cloud (hidden entries excluded;
--   Realtime broadcast of the visible aggregate when visibility changes).
--
-- Idempotency: CREATE OR REPLACE FUNCTION makes both definitions safe to
--   re-run; the GRANT is naturally idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- broadcast_word_cloud(p_event_id uuid, p_prompt_id uuid) RETURNS void
--
--   Computes the current VISIBLE word-cloud aggregate for a prompt (visible =
--   is_hidden = false) as a jsonb array of { term, frequency } and emits a
--   single Supabase Realtime Broadcast message on the per-event word-cloud
--   topic ('event:{event_id}:wordcloud', event name 'word_cloud'). The payload
--   carries the RAW visible term/frequency pairs; stop-word exclusion and
--   monotonic sizing are applied client-side in src/lib/wordcloud.ts.
--
--   INTERNAL helper — NOT granted to anon/authenticated. Reached only via the
--   SECURITY DEFINER RPC below.
--
--   BEST-EFFORT: any failure inside is caught and turned into a WARNING so the
--   caller's moderation transaction is never rolled back by a Realtime problem
--   — the DB is authoritative (mirrors broadcast_vote_count).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION broadcast_word_cloud(
    p_event_id  uuid,
    p_prompt_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_terms jsonb;
BEGIN
    -- Compute the VISIBLE aggregate: group visible (is_hidden = false) responses
    -- by normalised_text, ordered by descending frequency then term (Req 6.13).
    -- Aggregate into a jsonb array of { term, frequency }; empty cloud → [].
    SELECT COALESCE(
               jsonb_agg(
                   jsonb_build_object('term', t.term, 'frequency', t.frequency)
                   ORDER BY t.frequency DESC, t.term ASC
               ),
               '[]'::jsonb
           )
      INTO v_terms
      FROM (
          SELECT normalised_text AS term,
                 count(*)         AS frequency
            FROM word_cloud_responses
           WHERE prompt_id = p_prompt_id
             AND is_hidden = false
           GROUP BY normalised_text
      ) t;

    -- Best-effort fan-out. If anything in the Realtime path fails, swallow it
    -- (log a WARNING) so the authoritative moderation transaction still commits.
    -- Named arguments are used so the call is unambiguous regardless of the
    -- positional ordering of realtime.send's parameters.
    BEGIN
        PERFORM realtime.send(
            topic   => 'event:' || p_event_id::text || ':wordcloud',
            event   => 'word_cloud',
            payload => jsonb_build_object(
                           'event_id',  p_event_id,
                           'prompt_id', p_prompt_id,
                           'terms',     v_terms
                       ),
            private => false
        );
    EXCEPTION
        WHEN OTHERS THEN
            -- Never let a Realtime Broadcast failure break moderation. The
            -- authoritative state is word_cloud_responses; this broadcast is a
            -- best-effort optimization (Req 6.15). Clients converge via their
            -- next read.
            RAISE WARNING 'broadcast_word_cloud: realtime broadcast failed for prompt % (event %): %',
                p_prompt_id, p_event_id, SQLERRM;
    END;
END;
$$;

COMMENT ON FUNCTION broadcast_word_cloud(uuid, uuid) IS
    'Best-effort Supabase Realtime Broadcast of the VISIBLE word-cloud aggregate '
    '(is_hidden = false) for a prompt on the per-event topic '
    '''event:{event_id}:wordcloud'' (event ''word_cloud''; payload event_id + '
    'prompt_id + terms[{term, frequency}], NO participant_identifier — Req 8.6/8.20). '
    'Carries the RAW visible term/frequency pairs; stop-word exclusion + monotonic '
    'sizing are applied client-side in src/lib/wordcloud.ts. Emits when an entry''s '
    'visibility changes (Req 6.15, 23.1, 23.2). Internal helper — NOT granted to '
    'anon/authenticated. Swallows any Realtime error so a broadcast failure never '
    'rolls back the moderation transaction.';

-- ----------------------------------------------------------------------------
-- set_word_cloud_response_hidden(p_response_id uuid, p_is_hidden boolean)
--   RETURNS word_cloud_responses
--
--   Admin-only hide/unhide of a single word-cloud submission. Sets is_hidden to
--   p_is_hidden (Req 6.12), writes a 'moderation' audit_log row (Req 21.19), and
--   broadcasts the recomputed VISIBLE aggregate for the prompt (Req 6.15).
--   Returns the updated row.
--
--   Error signals: response_not_found (unknown p_response_id, SQLSTATE P0001).
--
--   ADMIN authorisation: granted to `authenticated` only (NOT anon). For V1 any
--   authenticated user is an admin (Req 10.3).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_word_cloud_response_hidden(
    p_response_id uuid,
    p_is_hidden   boolean
)
RETURNS word_cloud_responses
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_prompt_id uuid;
    v_event_id  uuid;
    v_row       word_cloud_responses;
BEGIN
    -- 1. Load the response (capturing prompt_id + event_id for the broadcast /
    --    audit). Missing → response_not_found (P0001).
    SELECT r.prompt_id, r.event_id
      INTO v_prompt_id, v_event_id
      FROM word_cloud_responses r
     WHERE r.id = p_response_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'response_not_found'
            USING ERRCODE = 'P0001';
    END IF;

    -- 2. Apply the visibility change (Req 6.12). updated_at is refreshed by the
    --    trg_word_cloud_responses_set_updated_at trigger (…000019).
    UPDATE word_cloud_responses
       SET is_hidden = p_is_hidden
     WHERE id = p_response_id
    RETURNING * INTO v_row;

    -- 3. AUDIT (Req 21.19): one audit_log row per moderation change with
    --    change_type='moderation' and the response's event_id — mirroring how
    --    the moderate-question edge function audits moderation. occurred_at is
    --    DB-defaulted to now() (UTC).
    INSERT INTO audit_log (change_type, event_id)
    VALUES ('moderation', v_event_id);

    -- 4. (Req 6.15) Fan the recomputed VISIBLE aggregate out to connected
    --    clients via Supabase Realtime Broadcast on the per-event word-cloud
    --    topic, within the 2-second target (Req 23.1, 23.2). BEST-EFFORT:
    --    broadcast_word_cloud swallows any Realtime error so a fan-out failure
    --    can never roll back this committed moderation change. The payload is
    --    event-scoped and carries NO participant_identifier (Req 8.6/8.20).
    PERFORM broadcast_word_cloud(v_event_id, v_prompt_id);

    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION set_word_cloud_response_hidden(uuid, boolean) IS
    'Admin-only hide/unhide of a single word_cloud_responses row: sets '
    'is_hidden = p_is_hidden (Req 6.12; updated_at via trigger), writes a '
    '''moderation'' audit_log row (Req 21.19), and best-effort broadcasts the '
    'recomputed VISIBLE aggregate for the prompt via Realtime (Req 6.15, 23.1, '
    '23.2). Returns the updated row. SECURITY DEFINER (server-mediated; '
    'word_cloud_responses has no client UPDATE policy). Error signals: '
    'response_not_found (unknown id, SQLSTATE P0001). Granted to authenticated '
    'only (NOT anon); V1 = any authenticated user is an admin (Req 10.3).';

-- ----------------------------------------------------------------------------
-- Grants.
--   set_word_cloud_response_hidden — admin action: EXECUTE to `authenticated`
--     ONLY (NOT anon). V1 = any authenticated user is an admin (Req 10.3).
--   broadcast_word_cloud — internal helper reached only through the SECURITY
--     DEFINER RPC (with definer rights); intentionally NOT granted to
--     anon/authenticated.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION set_word_cloud_response_hidden(uuid, boolean) TO authenticated;
