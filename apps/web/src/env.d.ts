/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_APP_ENV?: "development" | "staging" | "production";
  readonly VITE_DEV_ANONYMOUS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
