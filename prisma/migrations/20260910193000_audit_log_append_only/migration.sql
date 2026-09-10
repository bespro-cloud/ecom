-- Append-only enforcement for the audit log and the consent ledger.
--
-- Section 32 of the platform brief requires audit records to be append-only
-- from normal application workflows. Application-level discipline is not
-- enough: a bug, an ORM `updateMany`, or a compromised service account could
-- rewrite history. These triggers make the database refuse.
--
-- Rows are still removable by a superuser running an explicit retention job
-- (see docs/operations/RETENTION.md), which is intentionally a privileged,
-- out-of-band operation rather than something the application can do.

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER customer_consents_no_update
  BEFORE UPDATE ON "customer_consents"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER customer_consents_no_delete
  BEFORE DELETE ON "customer_consents"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- A partial unique index is the only reliable way to guarantee "at most one
-- default shipping address per customer" under concurrency; an application
-- check would race between two simultaneous requests.
CREATE UNIQUE INDEX customer_addresses_one_default_shipping
  ON "customer_addresses" ("customer_id")
  WHERE "is_default_shipping" = true AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX customer_addresses_one_default_billing
  ON "customer_addresses" ("customer_id")
  WHERE "is_default_billing" = true AND "deleted_at" IS NULL;

-- A user may only hold one un-consumed token of a given type at a time; the
-- application invalidates the previous one before issuing a new one.
CREATE INDEX user_tokens_active
  ON "user_tokens" ("user_id", "type")
  WHERE "consumed_at" IS NULL;

-- Case-insensitive lookups on the normalised email happen on every login.
CREATE INDEX users_email_normalized_active
  ON "users" ("email_normalized")
  WHERE "deleted_at" IS NULL;
