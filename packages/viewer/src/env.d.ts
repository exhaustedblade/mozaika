// Build-time variables that Vite exposes through import.meta.env.
interface ImportMetaEnv {
  /** Commit the preview was built from; set by CI. */
  readonly VITE_COMMIT_SHA?: string;
}
