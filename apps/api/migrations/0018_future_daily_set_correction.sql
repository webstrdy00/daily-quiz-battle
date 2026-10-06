-- Only the validated switch function can mint this transaction-scoped fence.
-- Keep it outside public: runtime-role provisioning grants all public tables.
CREATE SCHEMA content_correction_private;
REVOKE ALL ON SCHEMA content_correction_private FROM PUBLIC;

CREATE TABLE content_correction_private.authorizations (
  transaction_id xid8 NOT NULL,
  daily_set_id uuid NOT NULL,
  expected_version integer NOT NULL,
  old_items jsonb NOT NULL,
  new_items jsonb NOT NULL,
  PRIMARY KEY (transaction_id, daily_set_id)
);
REVOKE ALL ON content_correction_private.authorizations FROM PUBLIC;

CREATE FUNCTION content_correction_private.assert_future_unplayed(p_daily_set_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  target public.daily_sets%ROWTYPE;
BEGIN
  SELECT * INTO target FROM public.daily_sets
  WHERE id = p_daily_set_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DAILY_SET_NOT_FOUND';
  END IF;
  IF target.status <> 'published' OR target.published_at IS NULL THEN
    RAISE EXCEPTION 'DAILY_SET_NOT_PUBLISHED';
  END IF;
  -- Wall clock is deliberately independent of caller/injected audit time.
  IF target.quiz_date <= (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date THEN
    RAISE EXCEPTION 'DAILY_SET_NOT_FUTURE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.daily_set_voids WHERE daily_set_id = target.id) THEN
    RAISE EXCEPTION 'DAILY_SET_ALREADY_VOIDED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.attempts WHERE daily_set_id = target.id) THEN
    RAISE EXCEPTION 'DAILY_SET_ALREADY_PLAYED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.challenges WHERE daily_set_id = target.id) THEN
    RAISE EXCEPTION 'DAILY_SET_ALREADY_CHALLENGED';
  END IF;
END;
$$;

CREATE FUNCTION content_correction_private.authorized_items(
  p_daily_set_id uuid,
  p_position integer,
  p_revision_id uuid,
  p_choice_order jsonb,
  p_old boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  fence content_correction_private.authorizations%ROWTYPE;
  expected_item jsonb;
BEGIN
  SELECT * INTO fence FROM content_correction_private.authorizations
  WHERE transaction_id = pg_current_xact_id() AND daily_set_id = p_daily_set_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM content_correction_private.assert_future_unplayed(p_daily_set_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.daily_sets
    WHERE id = p_daily_set_id AND version = fence.expected_version
  ) THEN
    RETURN false;
  END IF;
  expected_item := (CASE WHEN p_old THEN fence.old_items ELSE fence.new_items END)
    -> (p_position - 1);
  RETURN expected_item = jsonb_build_object(
    'revisionId', p_revision_id, 'choiceOrder', p_choice_order
  );
END;
$$;

-- Preserve the original ordered locks and all draft mutation behavior.
-- The trigger alone needs elevated access to inspect the private fence.
CREATE OR REPLACE FUNCTION public.enforce_daily_set_item_mutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  old_status public.daily_set_status;
  new_status public.daily_set_status;
  locked_set record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO new_status FROM public.daily_sets
    WHERE id = NEW.daily_set_id FOR UPDATE;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT status INTO old_status FROM public.daily_sets
    WHERE id = OLD.daily_set_id FOR UPDATE;
  ELSIF OLD.daily_set_id = NEW.daily_set_id THEN
    SELECT status INTO old_status FROM public.daily_sets
    WHERE id = OLD.daily_set_id FOR UPDATE;
    new_status := old_status;
  ELSE
    FOR locked_set IN
      SELECT id, status FROM public.daily_sets
      WHERE id IN (OLD.daily_set_id, NEW.daily_set_id) ORDER BY id FOR UPDATE
    LOOP
      IF locked_set.id = OLD.daily_set_id THEN old_status := locked_set.status; END IF;
      IF locked_set.id = NEW.daily_set_id THEN new_status := locked_set.status; END IF;
    END LOOP;
  END IF;

  IF TG_OP <> 'INSERT' AND old_status <> 'draft' THEN
    IF TG_OP <> 'DELETE' OR content_correction_private.authorized_items(
      OLD.daily_set_id, OLD.position, OLD.question_revision_id, OLD.choice_order, true
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'published daily set items are immutable';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND new_status <> 'draft' THEN
    IF TG_OP <> 'INSERT' OR content_correction_private.authorized_items(
      NEW.daily_set_id, NEW.position, NEW.question_revision_id, NEW.choice_order, false
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'published daily set items are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- A SECURITY DEFINER trigger can inspect the private fence without exposing it
-- to runtime callers. The item trigger above also needs this narrow access.
CREATE FUNCTION public.enforce_published_daily_set_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  fence content_correction_private.authorizations%ROWTYPE;
BEGIN
  IF OLD.published_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.quiz_date IS DISTINCT FROM OLD.quiz_date
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'published daily set identity is immutable';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    SELECT * INTO fence FROM content_correction_private.authorizations
    WHERE transaction_id = pg_current_xact_id() AND daily_set_id = OLD.id;
    IF NOT FOUND OR OLD.version <> fence.expected_version
      OR NEW.version <> OLD.version + 1 OR NEW.status <> OLD.status
    THEN
      RAISE EXCEPTION 'published daily set version is immutable';
    END IF;
    PERFORM content_correction_private.assert_future_unplayed(OLD.id);
    IF (
      SELECT jsonb_agg(jsonb_build_object(
        'revisionId', question_revision_id, 'choiceOrder', choice_order
      ) ORDER BY position)
      FROM public.daily_set_items WHERE daily_set_id = OLD.id
    ) IS DISTINCT FROM fence.new_items THEN
      RAISE EXCEPTION 'daily set correction items do not match authorization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER daily_sets_published_identity_trg
BEFORE UPDATE ON public.daily_sets
FOR EACH ROW EXECUTE FUNCTION public.enforce_published_daily_set_identity();

-- Starts already share-lock daily_sets in the service. Also serialize raw
-- assignment against corrections and disallow future assignment at the DB.
-- Do not date-gate existing attempts/challenges on unrelated state updates.
CREATE FUNCTION public.enforce_daily_set_assignment_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  set_date date;
BEGIN
  SELECT quiz_date INTO set_date FROM public.daily_sets
  WHERE id = NEW.daily_set_id FOR SHARE;
  IF set_date > (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date THEN
    RAISE EXCEPTION 'future daily sets cannot be assigned to attempts or challenges';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attempts_daily_set_assignment_trg
BEFORE INSERT OR UPDATE OF daily_set_id ON public.attempts
FOR EACH ROW EXECUTE FUNCTION public.enforce_daily_set_assignment_date();
CREATE TRIGGER challenges_daily_set_assignment_trg
BEFORE INSERT OR UPDATE OF daily_set_id ON public.challenges
FOR EACH ROW EXECUTE FUNCTION public.enforce_daily_set_assignment_date();
CREATE INDEX attempts_daily_set_id_idx ON public.attempts(daily_set_id);

CREATE FUNCTION public.correct_future_daily_set(
  p_daily_set_id uuid,
  p_expected_version integer,
  p_actor_subject text,
  p_reason text,
  p_items jsonb,
  p_corrected_at timestamptz
)
RETURNS TABLE (id uuid, version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target public.daily_sets%ROWTYPE;
  old_items jsonb;
  revision_ids uuid[];
  question_ids uuid[];
  item jsonb;
  revision record;
  revision_count integer := 0;
  easy_count integer := 0;
  medium_count integer := 0;
  hard_count integer := 0;
BEGIN
  p_actor_subject := regexp_replace(p_actor_subject, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  p_reason := regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  IF p_expected_version IS NULL OR p_expected_version < 1 OR p_expected_version >= 2147483647
    OR p_actor_subject IS NULL OR char_length(p_actor_subject) NOT BETWEEN 1 AND 100
    OR p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 500
    OR p_corrected_at IS NULL OR NOT isfinite(p_corrected_at)
    OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
  THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF jsonb_array_length(p_items) <> 5 THEN
    RAISE EXCEPTION 'DAILY_SET_ITEM_COUNT_INVALID';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(item) <> 'object'
      OR NOT (item ?& ARRAY['revisionId', 'choiceOrder'])
      OR (item - 'revisionId' - 'choiceOrder') <> '{}'::jsonb
      OR jsonb_typeof(item -> 'revisionId') <> 'string'
      OR (item ->> 'revisionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR jsonb_typeof(item -> 'choiceOrder') <> 'array'
    THEN
      RAISE EXCEPTION 'INVALID_REQUEST';
    END IF;
    IF jsonb_array_length(item -> 'choiceOrder') <> 4
      OR NOT ((item -> 'choiceOrder') @> '[0,1,2,3]'::jsonb)
    THEN
      RAISE EXCEPTION 'INVALID_REQUEST';
    END IF;
  END LOOP;
  -- UUID spelling is not content; normalize before matching the row fence.
  SELECT jsonb_agg(jsonb_build_object(
    'revisionId', (value ->> 'revisionId')::uuid, 'choiceOrder', value -> 'choiceOrder'
  ) ORDER BY ordinal) INTO p_items
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS entries(value, ordinal);

  -- Same ordering as publishDailySet: global publication fence, set, items,
  -- then revision UUIDs. This serializes the +/-14-day rule with publication.
  PERFORM pg_advisory_xact_lock(1378035794);
  PERFORM content_correction_private.assert_future_unplayed(p_daily_set_id);
  SELECT * INTO target FROM public.daily_sets WHERE daily_sets.id = p_daily_set_id;
  IF target.version <> p_expected_version THEN
    RAISE EXCEPTION 'DAILY_SET_VERSION_CONFLICT';
  END IF;
  PERFORM 1 FROM public.daily_set_items WHERE daily_set_id = target.id
  ORDER BY position FOR UPDATE;
  SELECT jsonb_agg(jsonb_build_object(
    'revisionId', question_revision_id, 'choiceOrder', choice_order
  ) ORDER BY position) INTO old_items
  FROM public.daily_set_items WHERE daily_set_id = target.id;
  IF old_items IS NULL OR jsonb_array_length(old_items) <> 5 THEN
    RAISE EXCEPTION 'DAILY_SET_ITEM_COUNT_INVALID';
  END IF;
  IF old_items = p_items THEN RAISE EXCEPTION 'DAILY_SET_CORRECTION_NO_CHANGE'; END IF;

  SELECT array_agg((value ->> 'revisionId')::uuid) INTO revision_ids
  FROM jsonb_array_elements(p_items);
  IF (SELECT count(DISTINCT value) FROM unnest(revision_ids) AS value) <> 5 THEN
    RAISE EXCEPTION 'DAILY_SET_REVISIONS_NOT_DISTINCT';
  END IF;
  question_ids := ARRAY[]::uuid[];
  FOR revision IN
    SELECT * FROM public.question_revisions
    WHERE question_revisions.id = ANY(revision_ids) ORDER BY question_revisions.id FOR UPDATE
  LOOP
    revision_count := revision_count + 1;
    IF revision.lifecycle_status <> 'published' THEN
      RAISE EXCEPTION 'DAILY_SET_REVISION_NOT_PUBLISHED';
    END IF;
    question_ids := array_append(question_ids, revision.question_id);
    IF revision.difficulty = 'easy' THEN easy_count := easy_count + 1;
    ELSIF revision.difficulty = 'medium' THEN medium_count := medium_count + 1;
    ELSE hard_count := hard_count + 1; END IF;
    -- Match publication: validity extends strictly past D+1 01:00 KST.
    -- next_review_at/source validity requirements remain enforced by the
    -- existing immutable revision constraints; no stricter review-date rule.
    IF revision.time_sensitive AND (
      revision.valid_until IS NULL OR revision.next_review_at IS NULL
      OR revision.valid_until <= ((target.quiz_date + time '16:00') AT TIME ZONE 'UTC')
    ) THEN
      RAISE EXCEPTION 'DAILY_SET_REVISION_VALIDITY_EXPIRED';
    END IF;
  END LOOP;
  IF revision_count <> 5 THEN RAISE EXCEPTION 'DAILY_SET_REVISION_INTEGRITY_ERROR'; END IF;
  IF (SELECT count(DISTINCT value) FROM unnest(question_ids) AS value) <> 5 THEN
    RAISE EXCEPTION 'DAILY_SET_LOGICAL_QUESTIONS_NOT_DISTINCT';
  END IF;
  IF easy_count <> 2 OR hard_count NOT BETWEEN 0 AND 1 OR medium_count <> 3 - hard_count THEN
    RAISE EXCEPTION 'DAILY_SET_DIFFICULTY_DISTRIBUTION_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.question_revisions WHERE question_revisions.id = ANY(revision_ids)
    GROUP BY category HAVING count(*) > 2
  ) THEN RAISE EXCEPTION 'DAILY_SET_CATEGORY_LIMIT_EXCEEDED'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.daily_sets ds
    JOIN public.daily_set_items dsi ON dsi.daily_set_id = ds.id
    JOIN public.question_revisions qr ON qr.id = dsi.question_revision_id
    WHERE ds.status = 'published' AND ds.id <> target.id
      AND ds.quiz_date BETWEEN target.quiz_date - 14 AND target.quiz_date + 14
      AND qr.question_id = ANY(question_ids)
  ) THEN RAISE EXCEPTION 'DAILY_SET_LOGICAL_QUESTION_RECENTLY_USED'; END IF;

  INSERT INTO content_correction_private.authorizations
    (transaction_id, daily_set_id, expected_version, old_items, new_items)
  VALUES (pg_current_xact_id(), target.id, target.version, old_items, p_items);
  -- Rebuild only these five positions, inside the locked atomic transaction.
  -- Delete+insert also permits valid position swaps without unique-key races.
  DELETE FROM public.daily_set_items WHERE daily_set_id = target.id;
  INSERT INTO public.daily_set_items (daily_set_id, position, question_revision_id, choice_order)
  SELECT target.id, ordinal::smallint, (value ->> 'revisionId')::uuid, value -> 'choiceOrder'
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS entries(value, ordinal);
  UPDATE public.daily_sets SET version = target.version + 1 WHERE daily_sets.id = target.id;
  INSERT INTO public.admin_audit_logs (actor_subject, action, resource_type, resource_id, metadata, created_at)
  VALUES (p_actor_subject, 'daily_set.correct', 'daily_set', target.id,
    jsonb_build_object(
      'action', 'daily_set.correct', 'reason', p_reason,
      'oldVersion', target.version, 'newVersion', target.version + 1,
      'oldItems', old_items, 'newItems', p_items
    ), p_corrected_at);
  DELETE FROM content_correction_private.authorizations
  WHERE transaction_id = pg_current_xact_id() AND daily_set_id = target.id;
  RETURN QUERY SELECT target.id, target.version + 1;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA content_correction_private FROM PUBLIC;
REVOKE ALL ON FUNCTION public.correct_future_daily_set(uuid, integer, text, text, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_daily_set_item_mutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_published_daily_set_identity() FROM PUBLIC;
-- Provisioning may run before or after migrations; grant only existing groups.
DO $$
DECLARE
  role_name text;
BEGIN
  -- Remove explicit execution grants inherited from any owner defaults too,
  -- not only the PostgreSQL PUBLIC default, before granting the API group.
  FOR role_name IN
    SELECT DISTINCT r.rolname FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    JOIN pg_roles r ON r.oid = acl.grantee
    WHERE p.oid = 'public.correct_future_daily_set(uuid,integer,text,text,jsonb,timestamptz)'::regprocedure
      AND r.oid <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.correct_future_daily_set(uuid, integer, text, text, jsonb, timestamptz) FROM %I', role_name);
  END LOOP;
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE rolname IN ('daily_quiz_api', 'daily_quiz_worker')
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA content_correction_private FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA content_correction_private FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA content_correction_private FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION public.correct_future_daily_set(uuid, integer, text, text, jsonb, timestamptz) FROM %I', role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daily_quiz_api') THEN
    GRANT EXECUTE ON FUNCTION public.correct_future_daily_set(uuid, integer, text, text, jsonb, timestamptz) TO daily_quiz_api;
  END IF;
END;
$$;
