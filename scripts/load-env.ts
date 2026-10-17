/**
 * Loads `.env` the same way Next does, at import time.
 *
 * Scripts must import this module *before* anything that reads `process.env` at
 * module scope (the Prisma client does, for instance), because ES module imports
 * are evaluated in order — so `import "./load-env";` has to be the first import
 * in the entry script.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true);
