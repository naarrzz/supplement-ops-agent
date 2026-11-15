// Loads the Apps Script core files into a Node vm context, the same way Apps Script
// loads them (shared global scope, no modules). Tests and the local MCP server use this,
// so the code they exercise is the exact code that gets pushed to Apps Script.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps-script', 'core');
export const CORE_FILES = ['OpsCore.js', 'OpsTools.js', 'OpsAgents.js'];

export function loadCore() {
  const context = vm.createContext({ console, JSON, Math, Date });
  for (const f of CORE_FILES) {
    let code;
    try {
      code = readFileSync(join(CORE_DIR, f), 'utf8');
    } catch {
      continue; // file not written yet
    }
    vm.runInContext(code, context, { filename: f });
  }
  return {
    OpsCore: vm.runInContext('typeof OpsCore !== "undefined" ? OpsCore : undefined', context),
    OpsTools: vm.runInContext('typeof OpsTools !== "undefined" ? OpsTools : undefined', context),
    OpsAgents: vm.runInContext('typeof OpsAgents !== "undefined" ? OpsAgents : undefined', context),
  };
}
