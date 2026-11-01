// Vercel entrypoint shim — do not delete.
// Vercel's project for this repo has Output Directory set to "public"
// (saved when the repo was first imported with a vercel.json that set
// it). Its backend detection therefore searches ONLY inside "public"
// for an entrypoint named app/index/server.{js,cjs,mjs,...} that
// imports Express, and it does not look at the root server.js.
// This file lives in "public" so it is found, it directly requires
// Express (the detector looks for a direct import, not a transitive
// one), and it re-exports the real app from the root server.js.
// Locally, `npm start` still uses the root server.js directly.
const express = require("express");
void express;
module.exports = require("../server.js");
