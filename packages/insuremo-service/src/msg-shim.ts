/**
 * Thin re-export of the harness user-message builder for the profile
 * runtime-context (TASK-044 B). Kept behind a local module so the archive
 * surface stays one import seam.
 */
export { createUserMessage } from "@deepseek-ai/dsh-llm";
