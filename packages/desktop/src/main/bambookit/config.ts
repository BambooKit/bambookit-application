import { CHANNEL } from "../constants"

/**
 * BambooKit configuration. Values are injected at build time (see electron.vite.config.ts,
 * which reads BAMBOOKIT_* from the environment or packages/desktop/.env.bambookit) and may be
 * overridden at runtime with the same environment variables. Nothing here is a secret: the
 * Supabase anon key is a public client key protected by Row Level Security.
 */
function pick(runtime: string | undefined, built: string | undefined, fallback = ""): string {
  return (runtime || built || fallback).trim()
}

const DEFAULT_API_URL = CHANNEL === "dev" ? "http://localhost:8080" : "https://bambookit-api.onrender.com"

export const BAMBOOKIT_CONFIG = {
  apiUrl: pick(process.env.BAMBOOKIT_API_URL, import.meta.env.BAMBOOKIT_API_URL, DEFAULT_API_URL).replace(/\/+$/, ""),
  supabaseUrl: pick(process.env.BAMBOOKIT_SUPABASE_URL, import.meta.env.BAMBOOKIT_SUPABASE_URL).replace(/\/+$/, ""),
  supabaseAnonKey: pick(process.env.BAMBOOKIT_SUPABASE_ANON_KEY, import.meta.env.BAMBOOKIT_SUPABASE_ANON_KEY),
  // Firebase project used for Google sign-in (registered in Supabase as third-party auth).
  firebaseApiKey: pick(process.env.BAMBOOKIT_FIREBASE_API_KEY, import.meta.env.BAMBOOKIT_FIREBASE_API_KEY),
  firebaseProjectId: pick(process.env.BAMBOOKIT_FIREBASE_PROJECT_ID, import.meta.env.BAMBOOKIT_FIREBASE_PROJECT_ID),
  firebaseAuthDomain: pick(process.env.BAMBOOKIT_FIREBASE_AUTH_DOMAIN, import.meta.env.BAMBOOKIT_FIREBASE_AUTH_DOMAIN),
  // Fixed loopback port for the local Google sign-in page (http://localhost:54329/firebase-login).
  oauthCallbackPort: Number(process.env.BAMBOOKIT_OAUTH_PORT || 54329),
}

export function isAuthConfigured(): boolean {
  return !!BAMBOOKIT_CONFIG.supabaseUrl && !!BAMBOOKIT_CONFIG.supabaseAnonKey
}
