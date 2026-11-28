/**
 * Preloaded (`node --require`) into the gate F build and server by gate-f.mjs:
 * modules resolve only inside H2G_MODULE_ROOT (a path list: the gate F folder and
 * npm's own folder for the build, app\ alone for the server). Without it, a module that is optional or missing here
 * (Next tries `@opentelemetry/api`, a native `@next/swc` binding, …) would be
 * looked up in every parent folder's node_modules (C:\node_modules can be
 * created by any local user) and in the global folders, and run with the
 * server's secrets before the Garmin firewall is installed.
 *
 * CommonJS: parent and global search paths outside the root are dropped.
 * ES modules: a resolve hook refuses any file outside the root.
 */
"use strict";
const Module = require("node:module");
const path = require("node:path");

const raw = process.env.H2G_MODULE_ROOT;
if (!raw) throw new Error("module-guard: H2G_MODULE_ROOT is not set");
const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
const roots = raw.split(path.delimiter).filter(Boolean).map((r) => path.resolve(r));
const rootsN = roots.map(norm);
const inside = (p) => {
  const n = norm(p);
  return rootsN.some((r) => n === r || n.startsWith(r + path.sep));
};

const nodeModulePaths = Module._nodeModulePaths;
Module._nodeModulePaths = function guardedNodeModulePaths(from) {
  return nodeModulePaths.call(this, from).filter(inside);
};
Module.globalPaths.length = 0;

const hooks = `
import { fileURLToPath } from "node:url";
import path from "node:path";
let rootsN = [];
const win = process.platform === "win32";
const norm = (p) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));
export function initialize(data) { rootsN = data.roots.map(norm); }
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (r.url.startsWith("file:")) {
    const n = norm(fileURLToPath(r.url));
    if (!rootsN.some((root) => n === root || n.startsWith(root + path.sep))) {
      throw new Error("module-guard: refusing " + r.url + " (outside " + rootsN.join(path.delimiter) + ")");
    }
  }
  return r;
}`;
Module.register(`data:text/javascript,${encodeURIComponent(hooks)}`, { data: { roots } });

module.exports = { roots, inside };
