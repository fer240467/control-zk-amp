/*
 * Transportes BLE.
 *  - AndroidTransport: puente nativo (window.AndroidBLE) de la app Android.
 *  - WebTransport: Web Bluetooth (Windows/Electron y Chrome).
 * Ambos exponen: scan(onFound), connect(dev), write(bytes), disconnect(), onData, onClose.
 */
(function (global) {
  'use strict';
  const { SERVICE, WRITE, NOTIFY } = global.RCSP;
  const toHex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  const fromHex = (h) => Uint8Array.from((h.match(/../g) || []).map((x) => parseInt(x, 16)));

  class AndroidTransport {
    constructor() {
      this.onData = null; this.onClose = null;
      global.__ble = {
        found: (json) => this._onFound && this._onFound(JSON.parse(json)),
        data: (h) => this.onData && this.onData(fromHex(h)),
        state: (s) => {
          if (s === 'connected' && this._conn) { this._conn.resolve(); this._conn = null; }
          if (s === 'disconnected') {
            if (this._conn) { this._conn.reject(new Error('No se pudo conectar')); this._conn = null; }
            this.onClose && this.onClose();
          }
        },
        error: (m) => { global.__zkLog && global.__zkLog('Android: ' + m); if (this._conn) { this._conn.reject(new Error(m)); this._conn = null; } },
        log: (m) => global.__zkLog && global.__zkLog('Android: ' + m),
      };
    }
    get needsList() { return true; }
    scan(onFound) { this._onFound = onFound; global.AndroidBLE.scan(); }
    stopScan() { global.AndroidBLE.stopScan(); }
    connect(dev) {
      return new Promise((resolve, reject) => { this._conn = { resolve, reject }; global.AndroidBLE.connect(dev.id); });
    }
    write(bytes) { global.AndroidBLE.write(toHex(bytes)); return Promise.resolve(); }
    disconnect() { global.AndroidBLE.disconnect(); }
    openUrl(u) { global.AndroidBLE.openUrl(u); }
  }

  class WebTransport {
    constructor() { this.onData = null; this.onClose = null; this.queue = Promise.resolve(); }
    get needsList() { return !!global.desktop; } // Electron muestra su propia lista
    scan(onFound) {
      if (global.desktop) global.desktop.onDevices((list) => list.forEach(onFound));
      this._req = navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE] });
      return this._req;
    }
    // En Windows la búsqueda termina sola al elegir la placa: no hay que cancelar nada.
    stopScan() { }
    cancel() { if (global.desktop) global.desktop.cancelChoose(); }
    async connect(dev) {
      if (global.desktop) global.desktop.choose(dev.id);
      const device = await this._req;
      this.device = device;
      device.addEventListener('gattserverdisconnected', () => this.onClose && this.onClose());
      const server = await device.gatt.connect();
      const svc = await server.getPrimaryService(SERVICE);
      this.wr = await svc.getCharacteristic(WRITE);
      const nt = await svc.getCharacteristic(NOTIFY);
      nt.addEventListener('characteristicvaluechanged', (e) => {
        const v = e.target.value;
        this.onData && this.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      });
      await nt.startNotifications();
      return device;
    }
    write(bytes) {
      // Se envía en trozos de 20 bytes (MTU mínimo de BLE); la placa los rearma.
      this.queue = this.queue.then(async () => {
        for (let i = 0; i < bytes.length; i += 20) {
          const part = bytes.slice(i, i + 20);
          if (this.wr.writeValueWithoutResponse && this.wr.properties.writeWithoutResponse) await this.wr.writeValueWithoutResponse(part);
          else await this.wr.writeValue(part);
        }
      }).catch((e) => console.error(e));
      return this.queue;
    }
    disconnect() { try { this.device && this.device.gatt.disconnect(); } catch (e) { /* nada */ } }
    openUrl(u) { if (global.desktop) global.desktop.openUrl(u); else window.open(u, '_blank'); }
  }

  global.createTransport = () => (global.AndroidBLE ? new AndroidTransport() : new WebTransport());
})(window);
