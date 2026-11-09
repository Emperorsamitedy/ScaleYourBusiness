/* global process, console */
// Vercel's build. A production deploy brings its database up to the code
// first: `db:migrate`, then `db:seed` (the question bank), then the app's
// own build. The database address stays in Vercel (it is Sensitive there,
// so it can't be pulled to a dev machine); the build is the one place that
// can reach it. A failing step fails the deploy, and Vercel keeps serving
// the deployment that was live. Preview builds skip the database.
//
// Migrations are forward-only and additive (CLAUDE.md conventions), so the
// live deployment keeps working if the build fails after migrating.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

// The install can fall back to --ignore-scripts when ffmpeg-static's binary
// download fails (vercel.json). Then footage renders and AI-video labelling
// refuse until a normal install: say so loudly, without failing the deploy.
if (
  !existsSync("node_modules/ffmpeg-static/ffmpeg") &&
  !existsSync("node_modules/ffmpeg-static/ffmpeg.exe")
) {
  console.warn(
    [
      "",
      "!!! WARNING: no ffmpeg binary (the install fell back to --ignore-scripts).",
      "!!! Footage renders and AI video stay off on this deployment; redeploy once",
      "!!! ffmpeg-static's download host answers again.",
      "",
    ].join("\n"),
  );
}

if (process.env.VERCEL_ENV === "production") {
  run("npx drizzle-kit migrate");
  run("npx tsx scripts/seed-bank.ts");
} else {
  console.log(`VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}: no database step`);
}
run("npx next build");
