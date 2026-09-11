ALTER TABLE daily_set_items
  DROP CONSTRAINT daily_set_items_choice_order_ck,
  ADD CONSTRAINT daily_set_items_choice_order_ck CHECK (
    jsonb_typeof(choice_order) = 'array'
    AND jsonb_array_length(choice_order) = 4
    AND choice_order @> '[0, 1, 2, 3]'::jsonb
  );
