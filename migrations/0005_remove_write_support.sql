DROP TABLE IF EXISTS write_drafts;
UPDATE oauth_scopes SET scope = trim(replace(scope, 'scombz:write', ''));
DELETE FROM oauth_scopes WHERE scope = '';
