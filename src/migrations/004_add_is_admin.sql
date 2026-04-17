-- Add is_admin flag for RBAC
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Create index for fast admin lookups
CREATE INDEX IF NOT EXISTS idx_auth_tokens_is_admin ON auth_tokens (is_admin);


UPDATE auth_tokens SET is_admin = true WHERE email = 'pramod.p@juspay.in';
