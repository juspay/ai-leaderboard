import crypto from 'crypto';

/**
 * Auth token management.
 * Tokens are lifetime-scoped per SSO email — one token per email, never expires.
 * Stored in the auth_tokens table (created by migration 002).
 */

export function createAuthManager(db) {
  return {
    /** Generate a cryptographically secure token */
    generateToken() {
      return crypto.randomBytes(32).toString('hex');
    },

    /** Get token record by email (returns { token, email, user_id } or null) */
    getByEmail(email) {
      return db
        .prepare('SELECT token, email, user_id FROM auth_tokens WHERE email = ?')
        .get(email.toLowerCase()) || null;
    },

    /** Get token record by token string */
    getByToken(token) {
      return db
        .prepare('SELECT token, email, user_id FROM auth_tokens WHERE token = ?')
        .get(token) || null;
    },

    /** Create a new token for an email (or return existing) */
    getOrCreateToken(email) {
      email = email.toLowerCase();
      const existing = this.getByEmail(email);
      if (existing) return existing;

      const token = this.generateToken();
      db.prepare(
        'INSERT INTO auth_tokens (token, email) VALUES (?, ?) ON CONFLICT (email) DO NOTHING'
      ).run(token, email);
      // Re-fetch in case a concurrent insert won the race
      return this.getByEmail(email);
    },

    /** Claim a leaderboard user for this token */
    claimUser(token, userId) {
      // Ensure no other token already has this user
      const conflict = db
        .prepare('SELECT email FROM auth_tokens WHERE user_id = ? AND token != ?')
        .get(userId, token);
      if (conflict) {
        return { error: `This user is already claimed by ${conflict.email}` };
      }

      db.prepare('UPDATE auth_tokens SET user_id = ? WHERE token = ?').run(userId, token);
      return { ok: true };
    },

    /** Clear the user mapping for a token, keeping the token itself */
    unlinkUser(token) {
      db.prepare('UPDATE auth_tokens SET user_id = NULL WHERE token = ?').run(token);
    },

    /** Get all user_ids that are already claimed */
    getClaimedUserIds() {
      const rows = db
        .prepare('SELECT user_id FROM auth_tokens WHERE user_id IS NOT NULL')
        .all();
      return new Set(rows.map(r => r.user_id));
    },
  };
}
