const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

let win;
let pickCallback = null;
let lastList = [];

function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 860, minWidth: 360, minHeight: 560,
    backgroundColor: '#0b0b0d',
    title: 'Control ZK Amp',
    icon: path.join(__dirname, 'app', 'img', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // Web Bluetooth: en vez del selector de Chrome, mandamos la lista a nuestra interfaz.
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    pickCallback = callback;
    lastList = devices.map((d) => ({ id: d.deviceId, name: d.deviceName }));
    win.webContents.send('ble-devices', lastList);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.on('ble-choose', (_e, id) => { if (pickCallback) { pickCallback(id); pickCallback = null; } });
ipcMain.on('ble-cancel', () => { if (pickCallback) { pickCallback(''); pickCallback = null; } });
ipcMain.on('open-url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
