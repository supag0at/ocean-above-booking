-- Grant matrix: one statement per line of A-01 section 3.3. Executed as fb_owner (owner of all app.* tables) after the migrations.
-- Idempotent: REVOKE then GRANT; safe to re-run. harness has NO database role (H-06).
-- fb_owner is only used by migrate / 00-roles.sh; no runtime service uses it (H-05, I-14).
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
-- M-20 (kept): A-01 3.3 REVOKEs only tables from PUBLIC. Also revoking schema privileges from PUBLIC and revoking
-- previous grants from the three runtime roles (so a re-run after a matrix change drops stale grants) are additions beyond the matrix.
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM fb_gateway, fb_hands, fb_booking;
GRANT USAGE ON SCHEMA app TO fb_gateway, fb_hands, fb_booking;

-- gateway
GRANT SELECT, INSERT              ON app.users            TO fb_gateway;
GRANT UPDATE (locale)             ON app.users            TO fb_gateway;
GRANT SELECT, INSERT              ON app.sessions         TO fb_gateway;
GRANT UPDATE (title, last_seq, last_user_seq, last_user_at, oldest_unconsumed_at, consumed_up_to_seq, open_run_id,
              last_agent_event_at, last_run_outcome, max_fence_seen, status, updated_at)
                                  ON app.sessions         TO fb_gateway;
GRANT SELECT, INSERT              ON app.events           TO fb_gateway;
GRANT SELECT                      ON app.quotes           TO fb_gateway;
GRANT SELECT                      ON app.quote_offers     TO fb_gateway;
GRANT SELECT                      ON app.tickets          TO fb_gateway;
GRANT SELECT                      ON app.user_memories    TO fb_gateway;
GRANT SELECT, INSERT              ON app.memory_deletions TO fb_gateway;

-- hands
GRANT SELECT (id, user_id, last_user_seq) ON app.sessions TO fb_hands;
GRANT SELECT, INSERT              ON app.quotes           TO fb_hands;
GRANT SELECT, INSERT              ON app.quote_offers     TO fb_hands;
GRANT SELECT, INSERT              ON app.tool_calls       TO fb_hands;
GRANT SELECT                      ON app.tickets          TO fb_hands;
GRANT SELECT, INSERT              ON app.user_memories    TO fb_hands;
GRANT SELECT                      ON app.memory_deletions TO fb_hands;

-- booking
GRANT SELECT                      ON app.quotes           TO fb_booking;
GRANT SELECT                      ON app.quote_offers     TO fb_booking;
GRANT SELECT, INSERT              ON app.tickets          TO fb_booking;
