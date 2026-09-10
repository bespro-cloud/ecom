-- Human-readable customer references (HC-000001).
--
-- A sequence rather than a random string: support staff read these out loud,
-- and a monotonic value is far easier to dictate and transcribe. It carries no
-- security meaning — authorisation is always by id and ownership, never by
-- reference — so its predictability is not a concern.
CREATE SEQUENCE IF NOT EXISTS customer_reference_seq
  AS BIGINT
  START WITH 1000
  INCREMENT BY 1
  NO CYCLE;
