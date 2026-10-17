import { config } from "dotenv";

// .env holds the real dev values; .env.test may override the database.
config({ path: ".env" });
config({ path: ".env.test", override: true });

// Tests must never need a signed-in browser session.
process.env.SESSION_SECRET ||= "test-session-secret-that-is-long-enough";
process.env.LOG_LEVEL ||= "error";
