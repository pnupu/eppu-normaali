import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALLOWED_USERS_PATH = path.join(__dirname, '../../allowed-users.json');

interface AllowedUser {
  email: string;
  isAdmin: boolean;
}

interface Session {
  email: string;
  name: string;
  isAdmin: boolean;
}

const sessions = new Map<string, Session>();

function loadAllowedUsers(): AllowedUser[] {
  try {
    if (fs.existsSync(ALLOWED_USERS_PATH)) {
      return JSON.parse(fs.readFileSync(ALLOWED_USERS_PATH, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveAllowedUsers(users: AllowedUser[]): void {
  fs.writeFileSync(ALLOWED_USERS_PATH, JSON.stringify(users, null, 2));
}

export function getSessionFromCookie(cookieHeader: string | undefined): Session | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;
  return sessions.get(match[1]) || null;
}

export async function verifyGoogleToken(idToken: string): Promise<{ email: string; name: string } | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;

  const client = new OAuth2Client(clientId);
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.email) return null;
    return { email: payload.email, name: payload.name || payload.email };
  } catch {
    return null;
  }
}

export function tryLogin(email: string, name: string): { token: string; isAdmin: boolean } | null {
  let users = loadAllowedUsers();

  // First user becomes admin automatically
  if (users.length === 0) {
    users.push({ email, isAdmin: true });
    saveAllowedUsers(users);
  }

  const user = users.find(u => u.email === email);
  if (!user) return null;

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { email, name, isAdmin: user.isAdmin });
  return { token, isAdmin: user.isAdmin };
}

export function inviteUser(adminEmail: string, newEmail: string): boolean {
  const users = loadAllowedUsers();
  const admin = users.find(u => u.email === adminEmail);
  if (!admin?.isAdmin) return false;
  if (users.find(u => u.email === newEmail)) return false;

  users.push({ email: newEmail, isAdmin: false });
  saveAllowedUsers(users);
  return true;
}
