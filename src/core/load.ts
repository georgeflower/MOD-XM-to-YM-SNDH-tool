import type { Module } from './types';
import { isXm, parseXm } from './xm';
import { isMod, parseMod } from './mod';

export function loadModule(buf: Uint8Array): Module {
  if (isXm(buf)) return parseXm(buf);
  if (isMod(buf)) return parseMod(buf);
  throw new Error('Unsupported file: expected an XM (FastTracker II) or a 31-sample MOD (ProTracker/xCHN) module');
}
