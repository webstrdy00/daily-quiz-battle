CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE identity_status AS ENUM ('active', 'deleted', 'blocked');
CREATE TYPE content_status AS ENUM ('draft', 'review', 'approved', 'published', 'retired');
CREATE TYPE difficulty AS ENUM ('easy', 'medium', 'hard');
CREATE TYPE daily_set_status AS ENUM ('draft', 'published', 'retired');
CREATE TYPE attempt_status AS ENUM ('started', 'completed', 'abandoned');
CREATE TYPE idempotency_status AS ENUM ('processing', 'completed');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anon_key_fingerprint varchar(64) NOT NULL,
  nickname varchar(20) NOT NULL DEFAULT '익명 도전자',
  identity_status identity_status NOT NULL DEFAULT 'active',
  identity_verified_at timestamptz NOT NULL,
  token_version integer NOT NULL DEFAULT 1,
  streak_days integer NOT NULL DEFAULT 0,
  last_daily_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_anon_key_fingerprint_uq UNIQUE (anon_key_fingerprint),
  CONSTRAINT users_nickname_length_ck CHECK (char_length(nickname) BETWEEN 1 AND 12),
  CONSTRAINT users_token_version_ck CHECK (token_version > 0),
  CONSTRAINT users_streak_days_ck CHECK (streak_days >= 0)
);

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE question_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL,
  category varchar(32) NOT NULL,
  difficulty difficulty NOT NULL,
  prompt text NOT NULL,
  choices jsonb NOT NULL,
  correct_index smallint NOT NULL,
  explanation text NOT NULL,
  source_url text NOT NULL,
  source_checked_at timestamptz NOT NULL,
  reviewer_id varchar(100) NOT NULL,
  lifecycle_status content_status NOT NULL DEFAULT 'draft',
  valid_until timestamptz,
  next_review_at timestamptz,
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_revisions_question_revision_uq UNIQUE (question_id, revision_number),
  CONSTRAINT question_revisions_revision_number_ck CHECK (revision_number > 0),
  CONSTRAINT question_revisions_choices_ck CHECK (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) = 4),
  CONSTRAINT question_revisions_correct_index_ck CHECK (correct_index BETWEEN 0 AND 3),
  CONSTRAINT question_revisions_prompt_length_ck CHECK (char_length(prompt) BETWEEN 1 AND 500)
);

CREATE TABLE daily_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_date date NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status daily_set_status NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_sets_quiz_date_uq UNIQUE (quiz_date),
  CONSTRAINT daily_sets_version_ck CHECK (version > 0),
  CONSTRAINT daily_sets_published_at_ck CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE TABLE daily_set_items (
  daily_set_id uuid NOT NULL REFERENCES daily_sets(id) ON DELETE CASCADE,
  position smallint NOT NULL,
  question_revision_id uuid NOT NULL REFERENCES question_revisions(id) ON DELETE RESTRICT,
  choice_order jsonb NOT NULL DEFAULT '[0, 1, 2, 3]'::jsonb,
  CONSTRAINT daily_set_items_pk PRIMARY KEY (daily_set_id, position),
  CONSTRAINT daily_set_items_revision_uq UNIQUE (daily_set_id, question_revision_id),
  CONSTRAINT daily_set_items_position_ck CHECK (position BETWEEN 1 AND 5),
  CONSTRAINT daily_set_items_choice_order_ck CHECK (jsonb_typeof(choice_order) = 'array' AND jsonb_array_length(choice_order) = 4)
);

CREATE TABLE attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  daily_set_id uuid NOT NULL REFERENCES daily_sets(id) ON DELETE RESTRICT,
  status attempt_status NOT NULL DEFAULT 'started',
  score smallint,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  abandoned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attempts_user_daily_set_uq UNIQUE (user_id, daily_set_id),
  CONSTRAINT attempts_score_ck CHECK (score BETWEEN 0 AND 5),
  CONSTRAINT attempts_state_ck CHECK (
    (status = 'started' AND score IS NULL AND completed_at IS NULL AND abandoned_at IS NULL)
    OR (status = 'completed' AND score IS NOT NULL AND completed_at IS NOT NULL AND abandoned_at IS NULL)
    OR (status = 'abandoned' AND score IS NULL AND completed_at IS NULL AND abandoned_at IS NOT NULL)
  )
);

CREATE INDEX attempts_status_started_at_idx ON attempts(status, started_at);

CREATE TABLE attempt_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  sequence smallint NOT NULL,
  question_revision_id uuid NOT NULL REFERENCES question_revisions(id) ON DELETE RESTRICT,
  selected_index smallint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attempt_answers_attempt_sequence_uq UNIQUE (attempt_id, sequence),
  CONSTRAINT attempt_answers_attempt_revision_uq UNIQUE (attempt_id, question_revision_id),
  CONSTRAINT attempt_answers_sequence_ck CHECK (sequence BETWEEN 1 AND 5),
  CONSTRAINT attempt_answers_selected_index_ck CHECK (selected_index BETWEEN 0 AND 3)
);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation varchar(120) NOT NULL,
  key_hash varchar(64) NOT NULL,
  request_hash varchar(64) NOT NULL,
  status idempotency_status NOT NULL DEFAULT 'processing',
  response_status integer,
  response_body jsonb,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_records_scope_uq UNIQUE (user_id, operation, key_hash),
  CONSTRAINT idempotency_records_response_status_ck CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599)
);

CREATE INDEX idempotency_records_expires_at_idx ON idempotency_records(expires_at);

CREATE OR REPLACE FUNCTION enforce_question_revision_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lifecycle_status IN ('published', 'retired') AND (
    NEW.question_id IS DISTINCT FROM OLD.question_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.difficulty IS DISTINCT FROM OLD.difficulty
    OR NEW.prompt IS DISTINCT FROM OLD.prompt
    OR NEW.choices IS DISTINCT FROM OLD.choices
    OR NEW.correct_index IS DISTINCT FROM OLD.correct_index
    OR NEW.explanation IS DISTINCT FROM OLD.explanation
    OR NEW.source_url IS DISTINCT FROM OLD.source_url
    OR NEW.source_checked_at IS DISTINCT FROM OLD.source_checked_at
    OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id
  ) THEN
    RAISE EXCEPTION 'published question revisions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER question_revisions_immutable_trg
BEFORE UPDATE ON question_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_question_revision_immutability();

CREATE OR REPLACE FUNCTION enforce_daily_set_item_mutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_set_id uuid;
  target_status daily_set_status;
BEGIN
  target_set_id := COALESCE(NEW.daily_set_id, OLD.daily_set_id);
  SELECT status INTO target_status FROM daily_sets WHERE id = target_set_id;
  IF target_status <> 'draft' THEN
    RAISE EXCEPTION 'published daily set items are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER daily_set_items_mutable_trg
BEFORE INSERT OR UPDATE OR DELETE ON daily_set_items
FOR EACH ROW EXECUTE FUNCTION enforce_daily_set_item_mutability();

CREATE OR REPLACE FUNCTION enforce_daily_set_publish_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item_count integer;
BEGIN
  IF NEW.status = 'published' AND OLD.status <> 'published' THEN
    SELECT count(*) INTO item_count FROM daily_set_items WHERE daily_set_id = NEW.id;
    IF item_count <> 5 THEN
      RAISE EXCEPTION 'published daily sets must have exactly five items';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER daily_sets_publish_count_trg
BEFORE UPDATE ON daily_sets
FOR EACH ROW EXECUTE FUNCTION enforce_daily_set_publish_count();

CREATE OR REPLACE FUNCTION enforce_answer_insert_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status attempt_status;
BEGIN
  SELECT status INTO current_status FROM attempts WHERE id = NEW.attempt_id FOR UPDATE;
  IF current_status <> 'started' THEN
    RAISE EXCEPTION 'answers can only be inserted into started attempts';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attempt_answers_insert_state_trg
BEFORE INSERT ON attempt_answers
FOR EACH ROW EXECUTE FUNCTION enforce_answer_insert_state();

CREATE OR REPLACE FUNCTION prevent_answer_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'submitted answers are immutable';
END;
$$;

CREATE TRIGGER attempt_answers_no_update_trg
BEFORE UPDATE ON attempt_answers
FOR EACH ROW EXECUTE FUNCTION prevent_answer_update();
