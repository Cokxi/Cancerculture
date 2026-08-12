\set ON_ERROR_STOP on

begin read only;
\ir prelaunchApplicationDataFactoryResetPreservedFingerprint.inc.sql
\echo :preserved_fingerprint_md5
rollback;
