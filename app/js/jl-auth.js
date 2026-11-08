/*
 * Autenticación RCSP de JieLi — implementación propia.
 *
 * El chip Bluetooth JieLi exige un desafío/respuesta antes de aceptar comandos.
 * La respuesta se calcula con el algoritmo E1 del estándar Bluetooth (basado en
 * el cifrado SAFER+), con una clave y una dirección fijas. Este archivo
 * implementa E1 desde la especificación pública de Bluetooth Core.
 */
(function (global) {
  'use strict';

  // Constantes fijas que usa el firmware JieLi para la autenticación.
  const JL_KEY = [0x06, 0x77, 0x5f, 0x87, 0x91, 0x8d, 0xd4, 0x23, 0x00, 0x5d, 0xf1, 0xd8, 0xcf, 0x0c, 0x14, 0x2b];
  const JL_ADDR = [0x11, 0x22, 0x33, 0x33, 0x22, 0x11];

  // Tablas exponencial/logaritmo de SAFER+: e(x) = 45^x mod 257 (256 -> 0).
  const EXP = new Uint8Array(256);
  const LOG = new Uint8Array(256);
  (function () {
    let v = 1;
    for (let i = 0; i < 256; i++) {
      EXP[i] = v & 0xff; // 256 se representa como 0
      LOG[v & 0xff] = i;
      v = (v * 45) % 257;
    }
  })();

  // Posiciones que usan XOR (el resto usa suma mod 256).
  const XOR_POS = [true, false, false, true, true, false, false, true, true, false, false, true, true, false, false, true];
  // "Armenian shuffle" de SAFER+.
  const PERM = [8, 11, 12, 15, 2, 1, 6, 5, 10, 9, 14, 13, 0, 7, 4, 3];

  function keySchedule(key) {
    const reg = new Array(17);
    let x = 0;
    for (let i = 0; i < 16; i++) { reg[i] = key[i]; x ^= key[i]; }
    reg[16] = x;
    const keys = [key.slice()];
    for (let p = 2; p <= 17; p++) {
      for (let i = 0; i < 17; i++) reg[i] = ((reg[i] << 3) | (reg[i] >> 5)) & 0xff;
      const k = new Array(16);
      for (let i = 0; i < 16; i++) {
        // El firmware JieLi reduce el exponente módulo 256 (no 257).
        const bias = EXP[EXP[(17 * p + i + 1) & 0xff]];
        k[i] = (reg[(p - 1 + i) % 17] + bias) & 0xff;
      }
      keys.push(k);
    }
    return keys; // keys[0] = K1 ... keys[16] = K17
  }

  function pht(s) {
    for (let i = 0; i < 16; i += 2) {
      const a = s[i], b = s[i + 1];
      s[i] = (2 * a + b) & 0xff;
      s[i + 1] = (a + b) & 0xff;
    }
  }

  function round(s, k1, k2) {
    for (let i = 0; i < 16; i++) {
      if (XOR_POS[i]) s[i] = (EXP[s[i] ^ k1[i]] + k2[i]) & 0xff;
      else s[i] = LOG[(s[i] + k1[i]) & 0xff] ^ k2[i];
    }
    for (let layer = 0; layer < 4; layer++) {
      pht(s);
      if (layer < 3) {
        const t = s.slice();
        for (let i = 0; i < 16; i++) s[i] = t[PERM[i]];
      }
    }
  }

  // Ar (prime=false) y Ar' (prime=true) de la especificación Bluetooth.
  function ar(key, input, prime) {
    const ks = keySchedule(key);
    const s = input.slice();
    for (let r = 0; r < 8; r++) {
      if (prime && r === 2) {
        for (let i = 0; i < 16; i++) s[i] = XOR_POS[i] ? s[i] ^ input[i] : (s[i] + input[i]) & 0xff;
      }
      round(s, ks[2 * r], ks[2 * r + 1]);
    }
    const k17 = ks[16];
    for (let i = 0; i < 16; i++) s[i] = XOR_POS[i] ? s[i] ^ k17[i] : (s[i] + k17[i]) & 0xff;
    return s;
  }

  const OFFSET = [
    [true, 233], [false, 229], [true, 223], [false, 193], [true, 179], [false, 167], [true, 149], [false, 131],
    [false, 233], [true, 229], [false, 223], [true, 193], [false, 179], [true, 167], [false, 149], [true, 131],
  ];

  /** E1(K, RAND, BD_ADDR) -> 16 bytes (SRES[4] + ACO[12]). */
  function e1(key, rand, addr) {
    const a = ar(key, rand, false);
    const mid = new Array(16);
    for (let i = 0; i < 16; i++) mid[i] = ((a[i] ^ rand[i]) + addr[i % 6]) & 0xff;
    const kt = key.map((b, i) => (OFFSET[i][0] ? (b + OFFSET[i][1]) : (b ^ OFFSET[i][1])) & 0xff);
    return ar(kt, mid, true);
  }

  /** Respuesta al desafío del equipo: entrada [0x00, 16 bytes] -> [0x01, 16 bytes]. */
  function authResponse(challenge17) {
    const rand = Array.from(challenge17.slice(1, 17));
    return Uint8Array.from([0x01, ...e1(JL_KEY, rand, JL_ADDR)]);
  }

  /** Desafío propio para verificar al equipo: [0x00, 16 bytes aleatorios]. */
  function randomChallenge() {
    const r = new Uint8Array(17);
    (global.crypto || require('crypto').webcrypto).getRandomValues(r);
    r[0] = 0;
    return r;
  }

  const AUTH_OK = Uint8Array.from([0x02, 0x70, 0x61, 0x73, 0x73]); // 0x02 "pass"

  const api = { e1, authResponse, randomChallenge, AUTH_OK, JL_KEY, JL_ADDR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.JLAuth = api;
})(typeof window !== 'undefined' ? window : globalThis);
