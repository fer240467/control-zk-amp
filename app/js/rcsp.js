/*
 * Protocolo RCSP (JieLi) + comandos de las placas ZK (TPA3116 / JieLi BT).
 * Código propio. El transporte BLE lo provee cada plataforma:
 *   transport.write(Uint8Array) -> Promise
 *   transport.onData = (Uint8Array) => void
 */
(function (global) {
  'use strict';
  const Auth = global.JLAuth;

  const OP = { TARGET_INFO: 3, DISCONNECT_CLASSIC: 6, GET_SYS_INFO: 7, SET_SYS_INFO: 8, CUSTOM: 255 };
  const SERVICE = '0000ae00-0000-1000-8000-00805f9b34fb';
  const WRITE = '0000ae01-0000-1000-8000-00805f9b34fb';
  const NOTIFY = '0000ae02-0000-1000-8000-00805f9b34fb';

  const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(' ');
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  class Rcsp {
    constructor(transport, log) {
      this.t = transport;
      this.log = log || (() => {});
      this.sn = 0;
      this.buf = [];
      this.pending = new Map();
      this.authState = 'none';
      this.onCustom = null; // (Uint8Array payload AA..55) => void
      this.t.onData = (d) => this._onData(d);
    }

    // ---------- Autenticación ----------
    authenticate() {
      return new Promise((resolve, reject) => {
        this._authResolve = resolve;
        this._authReject = reject;
        this.authState = 'waitDeviceAnswer';
        this._challenge = Auth.randomChallenge();
        this.log('→ desafío de autenticación');
        this.t.write(this._challenge);
        this._authTimer = setTimeout(() => {
          this.authState = 'none';
          reject(new Error('La placa no respondió a la autenticación'));
        }, 6000);
      });
    }

    _handleAuth(d) {
      if (this.authState === 'waitDeviceAnswer') {
        const expected = Auth.authResponse(this._challenge);
        if (!eq(Array.from(d), Array.from(expected))) {
          this.log('Respuesta de autenticación inesperada: ' + hex(d));
          clearTimeout(this._authTimer);
          this.authState = 'none';
          this._authReject(new Error('Autenticación rechazada'));
          return;
        }
        this.authState = 'waitDeviceChallenge';
        this.t.write(Auth.AUTH_OK);
      } else if (this.authState === 'waitDeviceChallenge') {
        if (d.length === 17 && d[0] === 0) {
          this.t.write(Auth.authResponse(d));
        } else if (eq(Array.from(d), Array.from(Auth.AUTH_OK))) {
          clearTimeout(this._authTimer);
          this.authState = 'ok';
          this.log('✓ autenticado');
          this._authResolve();
        }
      }
    }

    // ---------- Empaquetado ----------
    _pack(op, params, isCommand = true, needResp = true, status = 0, sn = null) {
      const s = sn === null ? (this.sn = (this.sn + 1) & 0xff) : sn;
      const body = isCommand ? [s, ...params] : [status, s, ...params];
      const flag = (isCommand ? 0x80 : 0) | (needResp ? 0x40 : 0);
      const len = body.length;
      return { sn: s, bytes: Uint8Array.from([0xfe, 0xdc, 0xba, flag, op, (len >> 8) & 0xff, len & 0xff, ...body, 0xef]) };
    }

    send(op, params, timeout = 3000) {
      const { sn, bytes } = this._pack(op, params);
      this.log('→ ' + hex(bytes));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(sn); resolve(null); }, timeout);
        this.pending.set(sn, (r) => { clearTimeout(timer); resolve(r); });
        this.t.write(bytes);
      });
    }

    _onData(d) {
      this.log('← datos: ' + hex(d) + '  "' + String.fromCharCode(...Array.from(d).map((b) => (b >= 32 && b < 127 ? b : 46))) + '"');
      if (this.onRaw) this.onRaw(d);
      if (this.authState !== 'ok' && this.authState !== 'none' && !(d[0] === 0xfe && d[1] === 0xdc)) {
        this._handleAuth(d);
        return;
      }
      this.buf.push(...d);
      this._parse();
    }

    _parse() {
      for (;;) {
        let i = 0;
        while (i + 2 < this.buf.length && !(this.buf[i] === 0xfe && this.buf[i + 1] === 0xdc && this.buf[i + 2] === 0xba)) i++;
        if (i) this.buf.splice(0, i);
        if (this.buf.length < 8) return;
        const len = (this.buf[5] << 8) | this.buf[6];
        const total = 7 + len + 1;
        if (this.buf.length < total) return;
        const pkt = this.buf.splice(0, total);
        if (pkt[total - 1] !== 0xef) continue;
        this._onPacket(pkt);
      }
    }

    _onPacket(p) {
      const flag = p[3], op = p[4];
      const body = p.slice(7, p.length - 1);
      this.log('← ' + hex(p));
      const isCommand = (flag & 0x80) !== 0;
      if (isCommand) {
        const sn = body[0];
        const params = Uint8Array.from(body.slice(1));
        if (flag & 0x40) {
          const r = this._pack(op, [], false, false, 0, sn);
          this.t.write(r.bytes);
        }
        if (op === OP.CUSTOM && this.onCustom) this.onCustom(params);
      } else {
        const status = body[0], sn = body[1];
        const params = Uint8Array.from(body.slice(2));
        const cb = this.pending.get(sn);
        if (cb) { this.pending.delete(sn); cb({ op, status, params }); }
        if (op === OP.CUSTOM && params.length && params[0] === 0xaa && this.onCustom) this.onCustom(params);
      }
    }

    // ---------- Comandos ----------
    custom(bytes) { return this.send(OP.CUSTOM, Array.from(bytes)); }
    getTargetInfo() { return this.send(OP.TARGET_INFO, [0xff, 0xff, 0xff, 0xff, 0x00]); }
    disconnectClassic() { return this.send(OP.DISCONNECT_CLASSIC, []); }
    setSysVolume(v) { return this.send(OP.SET_SYS_INFO, [0xff, 0x02, 0x01, v & 0xff]); }
  }

  // Comandos propios de las placas ZK (formato AA <len> <cmd> ... 55)
  const ZK = {
    readProduct: () => [0xaa, 0x01, 0x01, 0x55],
    readSource: () => [0xaa, 0x01, 0x07, 0x55],
    readGain: () => [0xaa, 0x01, 0x19, 0x55],
    readDspEq: () => [0xaa, 0x01, 0x1b, 0x55],
    readDspState: () => [0xaa, 0x01, 0x1f, 0x55],
    /** 1=Bluetooth 2=USB 3=AUX 4=tarjeta de sonido */
    setSource: (n) => [0xaa, 0x02, 0x08, n, 0x55],
    /** ganancia máxima / volumen principal 0..30 */
    setGain: (v) => [0xaa, 0x02, 0x09, v, 0x55],
    /** 0=perillas de la placa, 1=EQ desde la app, 2=filtro DSP */
    setControlMode: (n) => [0xaa, 0x02, 0x0f, n, 0x55],
    setBeep: (on) => [0xaa, 0x03, 0x02, on ? 1 : 0, 0x0f, 0x55],
    /** índices 0..20 (= -2.0 .. +2.0 dB) */
    setBalance: (l, r) => [0xaa, 0x03, 0x0c, l, r, 0x55],
    /** 0..14 dB */
    setDspGain: (stereo, sub) => [0xaa, 0x03, 0x0d, stereo, sub, 0x55],
    /** EQ en modo app: ganancia estéreo / sub */
    setEqGain: (stereo, sub) => [0xaa, 0x03, 0x20, stereo, sub, 0x55],
    /** índices de filtros: estéreo 0..45, sub 0..9 */
    setFilters: (stLo, stHi, subLo, subHi) => [0xaa, 0x05, 0x0e, stLo, stHi, subLo, subHi, 0x55],
    /** 10 bandas en dB (-12..+12) */
    setEq10: (bands) => [0xaa, 0x0c, 0x0b, 0x01, ...bands.map((b) => (b + 12) & 0xff), 0x55],
  };

  /** Interpreta respuestas AA .. 55 de la placa. */
  function parseZK(d) {
    if (d[0] !== 0xaa) return null;
    const a = (i, n) => String.fromCharCode(...d.slice(i, i + n));
    switch (d[2]) {
      case 0x01: return { kind: 'product', product: parseInt(a(3, 3), 10), firmware: a(6, 3) };
      case 0x07: case 0x21: return { kind: 'source', source: d[3] };
      case 0x19: return { kind: 'gain', gain: d[3] };
      case 0x1b: return { kind: 'dspEq', bands: Array.from(d.slice(4, 14), (v) => v - 12) };
      case 0x1f:
        if (d.length < 14) return null;
        return {
          kind: 'dspState', mode: d[3], left: d[4], right: d[5], stereoGain: d[6], subGain: d[7],
          stLo: d[8], stHi: d[9], subLo: d[10], subHi: d[11], eqStereoGain: d[12], eqSubGain: d[13],
        };
      case 0x0f: return { kind: 'controlMode', mode: d[3] };
      default: return { kind: 'unknown', raw: hex(d) };
    }
  }

  global.RCSP = { Rcsp, ZK, parseZK, OP, SERVICE, WRITE, NOTIFY, hex };
})(typeof window !== 'undefined' ? window : globalThis);
