-- pg_notify trigger that fires every time a row in `sessions` is
-- inserted or its raw_hash changes. The panel's SSE endpoint LISTENs
-- on this channel and forwards events to the browser so the "new
-- session" badge stays live without polling.
--
-- Payload: the affected session id (TEXT). Listeners parse on the wire.
CREATE OR REPLACE FUNCTION prosa_notify_session_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('prosa.session.changed', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prosa_sessions_notify ON sessions;
CREATE TRIGGER prosa_sessions_notify
AFTER INSERT OR UPDATE OF raw_hash ON sessions
FOR EACH ROW EXECUTE FUNCTION prosa_notify_session_changed();
