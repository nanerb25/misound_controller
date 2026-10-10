'use strict';
// MiSound live controller for the exact analyzed libmisound.so build.
// Runtime-only changes; no on-disk library modification.
const LIB_NAME = 'libmisound.so';
const PROCESS_DL_OFFSET = 0x1c790;
const SET_FX_PARAM_OFFSET = 0x3ee10;
const SET_ARRAY_OFFSET = 0x3faa0;
const GET_PARAMS_OFFSET = 0x40120;
const HANDLER_FX_OBJECT_OFFSET = 0x138;
const HANDLER_NATIVE_ENABLE_CACHE_OFFSET = 0x17c;
const HANDLER_BYPASS_OFFSET = 0x176;
const NATIVE_ENABLE_PARAM_ID = 19;
const EQ_PARAM_ID = 3;
const PROCESS_DL_PROLOGUE = [0xd10303ff, 0xa9067bfd];
const SET_FX_PARAM_PROLOGUE = [0xfc1b0fe8, 0xa900fbfd];
const SET_ARRAY_PROLOGUE = [0xa9bd7bfd, 0xf9000bf5];
const GET_PARAMS_PROLOGUE = [0xa9bc7bfd, 0xa9015ff8];
const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const REAPPLY_GAP_MS = 750;
const REAPPLY_DELAY_MS = 25; // Run setters off the real-time audio callback thread.

let mode = 'native'; // Do not force bypass on attach.
let lastHandler = ptr(0);
let lastHandlerKey = '';
let processCalls = 0;
let nativeSetter = null;
let arraySetter = null;
let getParamsFn = null;
let desiredNativeEnabled = null; // null means don't enforce until user chooses nativeoff/nativeon.
let desiredEq = null;            // float[] when a preset/custom EQ is active.
let stockEqByHandler = {};
let lastCallbackAt = 0;
let lastEnforcedAt = 0;
let lastEqAppliedAt = 0;
let nativeReapplyPending = false;
let eqReapplyPending = false;
let lastReportedHandler = '';

function hasPrologue(address, words) {
  try { return words.every((word, i) => address.add(i * 4).readU32() === word); }
  catch (_) { return false; }
}
function getExport(mod, name) {
  try { return mod.getExportByName(name); } catch (_) { return null; }
}
function okPtr(p) { return p !== null && !p.isNull(); }
function fxFor(handler) {
  if (!okPtr(handler)) return ptr(0);
  try { return handler.add(HANDLER_FX_OBJECT_OFFSET).readPointer(); }
  catch (_) { return ptr(0); }
}
function writeBypass(handler, enabled) {
  if (!okPtr(handler)) return false;
  try { handler.add(HANDLER_BYPASS_OFFSET).writeU16(enabled ? 1 : 0); return true; }
  catch (e) { send({type:'error', message:'bypass write failed: ' + e}); return false; }
}
function saveStockEq(handler, force) {
  const key = handler.toString();
  if (!force && stockEqByHandler[key]) return stockEqByHandler[key];
  const fx = fxFor(handler);
  if (!okPtr(fx) || getParamsFn === null) return null;
  try {
    const mem = Memory.alloc(40);
    mem.writeByteArray(new Uint8Array(40));
    getParamsFn(fx, EQ_PARAM_ID, mem);
    const values = [];
    for (let i = 0; i < 10; i++) values.push(mem.add(i * 4).readFloat());
    // Reject clearly uninitialized/corrupt values rather than using them as a restore target.
    if (!values.every(v => Number.isFinite(v) && Math.abs(v) < 24)) {
      return {ok:false, values:values, error:'EQ snapshot looked invalid; refusing to treat it as stock.'};
    }
    stockEqByHandler[key] = values;
    return values;
  } catch (e) { return {ok:false, error:String(e)}; }
}
function applyEq(handler, values) {
  if (!okPtr(handler)) return {ok:false, error:'No live MiSound handler yet. Start playback and retry.'};
  if (arraySetter === null) return {ok:false, error:'EQ array setter did not pass binary signature checks.'};
  if (!Array.isArray(values) || values.length !== 10 || !values.every(v => Number.isFinite(v) && Math.abs(v) <= 6)) {
    return {ok:false, error:'EQ requires 10 finite gains within +/-6 dB.'};
  }
  const fx = fxFor(handler);
  if (!okPtr(fx)) return {ok:false, error:'MiSoundFX object pointer is null.'};
  try {
    // Native function takes uint32_t*, but the EQ path interprets these words as floats.
    const mem = Memory.alloc(40);
    values.forEach((v, i) => mem.add(i * 4).writeFloat(v));
    arraySetter(fx, EQ_PARAM_ID, mem);
    desiredEq = values.slice();
    lastEqAppliedAt = Date.now();
    send({type:'eq-applied', values:values, bandsHz:EQ_BANDS});
    return {ok:true, mode:'custom', bandsHz:EQ_BANDS, gainsDb:values};
  } catch (e) { return {ok:false, error:String(e)}; }
}
function applyNative(handler, enabled, reason) {
  if (!okPtr(handler)) return {ok:false, error:'No live handler yet. Start playback and retry.'};
  if (nativeSetter === null) return {ok:false, error:'Native enable setter did not pass binary signature checks.'};
  const fx = fxFor(handler);
  if (!okPtr(fx)) return {ok:false, error:'MiSoundFX object pointer is null.'};
  try {
    writeBypass(handler, false);
    nativeSetter(fx, NATIVE_ENABLE_PARAM_ID, enabled ? 1 : 0);
    handler.add(HANDLER_NATIVE_ENABLE_CACHE_OFFSET).writeS32(enabled ? 1 : 0);
    lastEnforcedAt = Date.now();
    send({type:'native-enable', enabled:!!enabled, reason:reason || 'user-command', handler:handler.toString()});
    return {ok:true, enabled:!!enabled, mode:'native', reason:reason || 'user-command'};
  } catch (e) { return {ok:false, error:String(e)}; }
}
function scheduleNativeReapply(handler, reason) {
  if (nativeReapplyPending) return;
  nativeReapplyPending = true;
  setTimeout(function () {
    nativeReapplyPending = false;
    // Respect the latest user choice; never periodically spam the native setter.
    if (desiredNativeEnabled !== null && okPtr(lastHandler)) {
      applyNative(lastHandler, desiredNativeEnabled, reason);
    }
  }, REAPPLY_DELAY_MS);
}
function scheduleEqReapply(handler) {
  if (eqReapplyPending) return;
  eqReapplyPending = true;
  setTimeout(function () {
    eqReapplyPending = false;
    if (desiredEq !== null && okPtr(lastHandler)) applyEq(lastHandler, desiredEq);
  }, REAPPLY_DELAY_MS);
}

function onHandlerCallback(handler) {
  const now = Date.now();
  const key = handler.toString();
  const newHandler = key !== lastHandlerKey;
  const resumedAfterGap = lastCallbackAt !== 0 && (now - lastCallbackAt) >= REAPPLY_GAP_MS;
  lastCallbackAt = now;
  lastHandler = handler;
  processCalls++;
  if (newHandler) {
    lastHandlerKey = key;
    // Capture the handler's initial EQ once, before any preset is applied to it.
    saveStockEq(handler, false);
    if (key !== lastReportedHandler) {
      lastReportedHandler = key;
      send({type:'handler', pointer:key, newHandler:true, mode:mode});
    }
  }
  if (mode === 'hard') {
    writeBypass(handler, true);
    return;
  }
  writeBypass(handler, false);
  // Event-driven only: no timer/periodic native setter calls while music is playing.
  // A single asynchronous reapply is queued when a handler is recreated or a callback
  // resumes after a long gap, keeping setters off the real-time audio callback thread.
  if (desiredNativeEnabled !== null && (newHandler || resumedAfterGap)) {
    scheduleNativeReapply(handler, newHandler ? 'new-handler' : 'playback-resumed');
  }
  if (desiredEq !== null && (newHandler || resumedAfterGap)) {
    scheduleEqReapply(handler);
  }
}

const mod = Process.findModuleByName(LIB_NAME);
if (mod === null) throw new Error(LIB_NAME + ' is not mapped in this process. Attach to the PID whose maps show the library.');
const processDl = getExport(mod, 'misound_arsi_process_dl_buf');
if (processDl === null || processDl.sub(mod.base).toString() !== '0x1c790' || !hasPrologue(processDl, PROCESS_DL_PROLOGUE)) {
  throw new Error('Build mismatch: process_dl_buf offset/opcodes differ; refusing to hook this build.');
}
const setFxParamPtr = getExport(mod, '_ZN9MisoundFX10MisoundFX410setFxParamEij');
if (setFxParamPtr && setFxParamPtr.sub(mod.base).toString() === '0x3ee10' && hasPrologue(setFxParamPtr, SET_FX_PARAM_PROLOGUE)) {
  nativeSetter = new NativeFunction(setFxParamPtr, 'void', ['pointer','int','uint']);
}
const setArrayPtr = getExport(mod, '_ZN9MisoundFX10MisoundFX424setFxParamWithValueArrayEiPj');
if (setArrayPtr && setArrayPtr.sub(mod.base).toString() === '0x3faa0' && hasPrologue(setArrayPtr, SET_ARRAY_PROLOGUE)) {
  arraySetter = new NativeFunction(setArrayPtr, 'void', ['pointer','int','pointer']);
}
const getParamsPtr = getExport(mod, '_ZN9MisoundFX10MisoundFX49getParamsEiPj');
if (getParamsPtr && getParamsPtr.sub(mod.base).toString() === '0x40120' && hasPrologue(getParamsPtr, GET_PARAMS_PROLOGUE)) {
  getParamsFn = new NativeFunction(getParamsPtr, 'void', ['pointer','int','pointer']);
}
Interceptor.attach(processDl, { onEnter(args) { const handler = args[4]; if (okPtr(handler)) onHandlerCallback(handler); } });

function restoreStockEq() {
  if (!okPtr(lastHandler)) return {ok:false, error:'No live handler yet.'};
  const key = lastHandler.toString();
  const stock = stockEqByHandler[key] || saveStockEq(lastHandler, false);
  if (!stock || stock.ok === false) return {ok:false, error:'No valid stock snapshot: ' + JSON.stringify(stock)};
  const result = applyEq(lastHandler, stock);
  if (result.ok) { desiredEq = null; result.mode = 'stock-restored'; result.note = 'Restored the EQ snapshot captured for this handler.'; }
  return result;
}
const PRESETS = {
  bass:   [1.5, 2.0, 2.0, 1.5, 0.8, 0.0, 0.0, 0.0, 0.0, 0.0],
  treble: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 1.5, 1.5],
  clear:  [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
};
rpc.exports = {
  nativeoff() { desiredNativeEnabled = false; mode = 'native'; return applyNative(lastHandler, false, 'user-command'); },
  nativeon() { desiredNativeEnabled = true; mode = 'native'; return applyNative(lastHandler, true, 'user-command'); },
  hardoff() { mode = 'hard'; if (okPtr(lastHandler)) writeBypass(lastHandler, true); return {ok:true, mode:mode, handlerSeen:okPtr(lastHandler)}; },
  passthrough() { mode = 'native'; if (okPtr(lastHandler)) writeBypass(lastHandler, false); return {ok:true, mode:mode, note:'Direct bypass cleared; native state is not changed.'}; },
  preset(name) {
    const key = String(name || '').toLowerCase();
    if (key === 'stock') return restoreStockEq();
    if (!PRESETS[key]) return {ok:false, error:'Choose bass, treble, or clear (flat). Use stockeq to restore captured EQ.'};
    // Save stock before the first EQ change for this handler.
    const stock = saveStockEq(lastHandler, false);
    if (!stock || stock.ok === false) return {ok:false, error:'Could not capture stock EQ: ' + JSON.stringify(stock)};
    return applyEq(lastHandler, PRESETS[key]);
  },
  seteq(values) { const stock = saveStockEq(lastHandler, false); if (!stock || stock.ok === false) return {ok:false, error:'Could not capture stock EQ: ' + JSON.stringify(stock)}; return applyEq(lastHandler, values); },
  stockeq() { return restoreStockEq(); },
  eqshow() {
    if (!okPtr(lastHandler)) return {ok:false, error:'No live handler yet.'};
    const fx = fxFor(lastHandler); if (!okPtr(fx) || getParamsFn === null) return {ok:false, error:'getParams unavailable.'};
    try {
      const mem = Memory.alloc(40); mem.writeByteArray(new Uint8Array(40)); getParamsFn(fx, EQ_PARAM_ID, mem);
      const values=[]; for (let i=0;i<10;i++) values.push(mem.add(i*4).readFloat());
      return {ok:true, bandsHz:EQ_BANDS, gainsDb:values, stockSnapshot:stockEqByHandler[lastHandler.toString()] || null, desiredEq:desiredEq};
    } catch(e) { return {ok:false,error:String(e)}; }
  },
  status() { return {library:mod.name, base:mod.base.toString(), processOffset:processDl.sub(mod.base).toString(), nativeSetterAvailable:nativeSetter!==null, arraySetterAvailable:arraySetter!==null, getParamsAvailable:getParamsFn!==null, mode:mode, desiredNativeEnabled:desiredNativeEnabled, handlerSeen:okPtr(lastHandler), handler:okPtr(lastHandler)?lastHandler.toString():null, processCalls:processCalls, lastCallbackAt:lastCallbackAt, eqActive:desiredEq!==null, eqValues:desiredEq, eqBandsHz:EQ_BANDS}; }
};
send({type:'ready', library:mod.name, path:mod.path, buildChecked:true, nativeSetterAvailable:nativeSetter!==null, arraySetterAvailable:arraySetter!==null, getParamsAvailable:getParamsFn!==null, note:'EQ presets are conservative starting points; confirm band order/value behavior on device. Native/EQ reapply is event-driven only on handler changes and playback callback gaps; no periodic setter calls.'});
