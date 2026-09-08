-- P3-T12 extends the existing EU-12 release authority with the exact detached
-- two-component Bridge update contract. Existing sequence and rollback-floor
-- columns remain authoritative.

ALTER TABLE bridge_releases
  ADD COLUMN manifest_json jsonb,
  ADD COLUMN signature_envelope_json jsonb,
  ADD COLUMN bridge_storage_key text,
  ADD COLUMN bridge_sha256 char(64),
  ADD COLUMN bridge_size_bytes bigint,
  ADD COLUMN addin_storage_key text,
  ADD COLUMN addin_sha256 char(64),
  ADD COLUMN addin_size_bytes bigint,
  ADD COLUMN rollout_percent integer;

UPDATE bridge_releases
SET manifest_json = '{}'::jsonb,
    signature_envelope_json = '{}'::jsonb,
    bridge_storage_key = artifact_storage_key,
    bridge_sha256 = artifact_sha256,
    bridge_size_bytes = 1,
    addin_storage_key = artifact_storage_key || '.legacy-addin-unavailable',
    addin_sha256 = artifact_sha256,
    addin_size_bytes = 1,
    rollout_percent = 0
WHERE manifest_json IS NULL;

ALTER TABLE bridge_releases
  ALTER COLUMN manifest_json SET NOT NULL,
  ALTER COLUMN signature_envelope_json SET NOT NULL,
  ALTER COLUMN bridge_storage_key SET NOT NULL,
  ALTER COLUMN bridge_sha256 SET NOT NULL,
  ALTER COLUMN bridge_size_bytes SET NOT NULL,
  ALTER COLUMN addin_storage_key SET NOT NULL,
  ALTER COLUMN addin_sha256 SET NOT NULL,
  ALTER COLUMN addin_size_bytes SET NOT NULL,
  ALTER COLUMN rollout_percent SET NOT NULL,
  ADD CONSTRAINT bridge_releases_manifest_object_check CHECK (jsonb_typeof(manifest_json) = 'object'),
  ADD CONSTRAINT bridge_releases_signature_object_check CHECK (jsonb_typeof(signature_envelope_json) = 'object'),
  ADD CONSTRAINT bridge_releases_bridge_sha_check CHECK (bridge_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT bridge_releases_addin_sha_check CHECK (addin_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT bridge_releases_component_size_check CHECK (bridge_size_bytes > 0 AND addin_size_bytes > 0),
  ADD CONSTRAINT bridge_releases_rollout_percent_check CHECK (rollout_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT bridge_releases_bridge_storage_key_key UNIQUE (bridge_storage_key),
  ADD CONSTRAINT bridge_releases_addin_storage_key_key UNIQUE (addin_storage_key);

CREATE TABLE bridge_release_device_rings (
  channel bridge_release_channel NOT NULL REFERENCES release_channels(channel) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  ring integer NOT NULL CHECK (ring BETWEEN 0 AND 99),
  rollout_revision integer NOT NULL CHECK (rollout_revision > 0),
  PRIMARY KEY (channel, tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id)
);

CREATE POLICY tenant_scope ON bridge_release_device_rings USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
ALTER TABLE bridge_release_device_rings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridge_release_device_rings FORCE ROW LEVEL SECURITY;
GRANT SELECT ON bridge_release_device_rings TO revagent_app;

CREATE OR REPLACE FUNCTION revagent_bridge_release_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'bridge release rows are immutable';
END;
$$;

CREATE TRIGGER bridge_releases_immutable
BEFORE UPDATE OR DELETE ON bridge_releases
FOR EACH ROW EXECUTE FUNCTION revagent_bridge_release_immutable();
