-- Ownership invariants: at least one owner per site, and the site's owner is an
-- accepted owner member of that site (docs snapshot 02 §6).
--
-- Rollout note: additive. Enforces invariants the schema could not state before;
-- an empty database trivially satisfies them, and the transaction service
-- (packages/postgres/src/repositories/sites.ts) creates sites in an order that
-- holds them. There is no backfill because the history starts from empty.
--
-- A plain foreign key cannot express "owner_user_id must be a site_members row
-- whose role is owner" — that is a cross-table role predicate. It is enforced by
-- a DEFERRABLE INITIALLY DEFERRED constraint trigger so that a single
-- transaction may pass through intermediate states (insert the site, then its
-- owner membership) and is only checked at commit.

CREATE OR REPLACE FUNCTION assert_site_ownership() RETURNS trigger AS $$
DECLARE
  target_site uuid;
  site_owner  uuid;
  owner_count integer;
BEGIN
  IF TG_TABLE_NAME = 'sites' THEN
    target_site := COALESCE(NEW.id, OLD.id);
  ELSE
    target_site := COALESCE(NEW.site_id, OLD.site_id);
  END IF;

  -- The site may be gone (e.g. a cascade delete of its members). Nothing to
  -- check then; the deletion itself is the intended end state.
  SELECT s.owner_user_id INTO site_owner FROM sites s WHERE s.id = target_site;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO owner_count
  FROM site_members m
  WHERE m.site_id = target_site AND m.role = 'owner';

  IF owner_count < 1 THEN
    RAISE EXCEPTION 'site % must have at least one owner', target_site
      USING ERRCODE = 'OA001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM site_members m
    WHERE m.site_id = target_site
      AND m.user_id = site_owner
      AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'owner % of site % must be an accepted owner member',
      site_owner, target_site
      USING ERRCODE = 'OA002';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER sites_ownership_invariant
  AFTER INSERT OR UPDATE ON sites
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_site_ownership();

CREATE CONSTRAINT TRIGGER site_members_ownership_invariant
  AFTER INSERT OR UPDATE OR DELETE ON site_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_site_ownership();
