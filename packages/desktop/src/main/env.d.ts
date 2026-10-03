interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  readonly OPENCODE_ENGINE_VERSION: string
  readonly BAMBOOKIT_API_URL: string
  readonly BAMBOOKIT_SUPABASE_URL: string
  readonly BAMBOOKIT_SUPABASE_ANON_KEY: string
  readonly BAMBOOKIT_FIREBASE_API_KEY: string
  readonly BAMBOOKIT_FIREBASE_PROJECT_ID: string
  readonly BAMBOOKIT_FIREBASE_AUTH_DOMAIN: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../opencode/dist/types/src/node").Server.listen
    export type Listener = import("../../../opencode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../opencode/dist/types/src/node").Config.get
    export type Info = import("../../../opencode/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../opencode/dist/types/src/node").bootstrap
}
