import { readFileSync, existsSync } from "node:fs";

/**
 * Load the project .env and let it OVERRIDE inherited environment variables.
 * (Node's --env-file does not override, so a stale OPENAI_API_KEY in the user's
 * system environment would silently win over the project's own key.)
 */
export function loadProjectEnv(file: URL): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (value === "") continue;
    process.env[m[1]] = value;
    loaded.push(m[1]);
  }
  return loaded;
}
