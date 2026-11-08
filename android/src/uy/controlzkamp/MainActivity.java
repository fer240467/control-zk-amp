package uy.controlzkamp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Control ZK Amp — app Android.
 * La interfaz es la misma que en Windows (HTML en assets/www); este archivo
 * solo provee el puente Bluetooth LE (window.AndroidBLE).
 */
@SuppressLint("MissingPermission")
public class MainActivity extends Activity {
    private static final UUID SERVICE = UUID.fromString("0000ae00-0000-1000-8000-00805f9b34fb");
    private static final UUID WRITE = UUID.fromString("0000ae01-0000-1000-8000-00805f9b34fb");
    private static final UUID NOTIFY = UUID.fromString("0000ae02-0000-1000-8000-00805f9b34fb");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final int REQ_PERMS = 7;

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private BluetoothAdapter adapter;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic wrChar;
    private int mtu = 23;
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();
    private boolean writing = false;
    private boolean scanning = false;
    private Runnable pendingAfterPerms;
    private String lastAddr;
    private int attempts = 0;
    private final java.util.HashSet<String> reported = new java.util.HashSet<>();
    private final java.util.HashMap<String, BluetoothDevice> scanned = new java.util.HashMap<>();
    private boolean ready = false;

    private boolean classicReg = false;
    private final android.content.BroadcastReceiver classicRx = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context c, Intent i) {
            if (!BluetoothDevice.ACTION_FOUND.equals(i.getAction())) return;
            BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
            if (d == null || d.getType() == BluetoothDevice.DEVICE_TYPE_LE) return;
            String n = d.getName();
            if (n == null) return;
            short rssi = i.getShortExtra(BluetoothDevice.EXTRA_RSSI, (short) 0);
            dbg("Clásico: " + n + " " + d.getAddress() + " tipo=" + d.getType());
            js("found", "{\"id\":\"" + d.getAddress() + "\",\"name\":\"" + n.replace("\"", "'").replace("\\", "") + "\",\"rssi\":" + rssi + ",\"classic\":true}");
        }
    };

    private void dbg(String m) { android.util.Log.i("ZKAMP", m); js("log", m); }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        adapter = bm != null ? bm.getAdapter() : null;
        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0B0D);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        web.addJavascriptInterface(new Bridge(), "AndroidBLE");
        final String auto = getIntent() != null ? getIntent().getStringExtra("auto") : null;
        final String watch = getIntent() != null ? getIntent().getStringExtra("watch") : null;
        web.setWebViewClient(new android.webkit.WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                if (auto != null) {
                    String a = auto.replace("'", "");
                    ui.postDelayed(() -> web.evaluateJavascript("window.__autoConnect && window.__autoConnect('" + a + "')", null), 800);
                }
                if (watch != null) {
                    String w = watch.replace("'", "");
                    getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    ui.postDelayed(() -> web.evaluateJavascript("window.__watch && window.__watch('" + w + "')", null), 800);
                }
            }
        });
        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        closeGatt();
        super.onDestroy();
    }

    // ---------- comunicación con la interfaz ----------
    private void js(final String fn, final String arg) {
        final String a = arg == null ? "" : arg.replace("\\", "\\\\").replace("'", "\\'");
        ui.post(() -> web.evaluateJavascript("window.__ble && window.__ble." + fn + "('" + a + "')", null));
    }

    private void toast(String m) { ui.post(() -> Toast.makeText(this, m, Toast.LENGTH_LONG).show()); }

    private static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    private static byte[] unhex(String h) {
        byte[] r = new byte[h.length() / 2];
        for (int i = 0; i < r.length; i++) r[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
        return r;
    }

    // ---------- permisos ----------
    private String[] neededPerms() {
        if (Build.VERSION.SDK_INT >= 31)
            return new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT};
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    private void withPerms(Runnable r) {
        if (Build.VERSION.SDK_INT < 23) { r.run(); return; }
        List<String> miss = new ArrayList<>();
        for (String p : neededPerms()) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) miss.add(p);
        if (miss.isEmpty()) { r.run(); return; }
        pendingAfterPerms = r;
        requestPermissions(miss.toArray(new String[0]), REQ_PERMS);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        boolean ok = res.length > 0;
        for (int x : res) ok &= x == PackageManager.PERMISSION_GRANTED;
        if (ok && pendingAfterPerms != null) pendingAfterPerms.run();
        else {
            toast("Sin permiso de Bluetooth no se puede buscar la placa.");
            js("state", "disconnected");
        }
        pendingAfterPerms = null;
    }

    // ---------- escaneo ----------
    private final ScanCallback scanCb = new ScanCallback() {
        @Override
        public void onScanResult(int type, ScanResult r) {
            BluetoothDevice d = r.getDevice();
            scanned.put(d.getAddress(), d);
            String name = r.getScanRecord() != null && r.getScanRecord().getDeviceName() != null
                    ? r.getScanRecord().getDeviceName() : d.getName();
            if (name == null) return;
            String json = "{\"id\":\"" + d.getAddress() + "\",\"name\":\"" + name.replace("\"", "'").replace("\\", "") + "\",\"rssi\":" + r.getRssi() + "}";
            js("found", json);
            if (!reported.contains(d.getAddress())) {
                reported.add(d.getAddress());
                String con = Build.VERSION.SDK_INT >= 26 ? (r.isConnectable() ? "sí" : "NO") : "?";
                dbg("Anuncio " + name + " " + d.getAddress() + " conectable=" + con + " tipo=" + d.getType());
                if (name.toUpperCase().contains("BYD") && r.getScanRecord() != null) {
                    android.bluetooth.le.ScanRecord sr = r.getScanRecord();
                    dbg("ANUNCIO-BYD crudo=" + hex(sr.getBytes()));
                    dbg("ANUNCIO-BYD servicios=" + sr.getServiceUuids());
                    android.util.SparseArray<byte[]> m = sr.getManufacturerSpecificData();
                    for (int k = 0; m != null && k < m.size(); k++) dbg("ANUNCIO-BYD fabricante=0x" + Integer.toHexString(m.keyAt(k)) + " datos=" + hex(m.valueAt(k)));
                }
            }
        }
    };

    private void startScan() {
        if (adapter == null) { toast("Este equipo no tiene Bluetooth."); return; }
        if (!adapter.isEnabled()) {
            try { startActivity(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)); } catch (Exception ignored) { }
            toast("Activá el Bluetooth y volvé a tocar Buscar.");
            js("state", "disconnected");
            return;
        }
        if (adapter.getBluetoothLeScanner() == null) return;
        stopScanInt();
        reported.clear();
        // Equipos vinculados o ya conectados: no se anuncian, pero se pueden conectar igual.
        try {
            java.util.LinkedHashMap<String, BluetoothDevice> extra = new java.util.LinkedHashMap<>();
            BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
            if (bm != null) for (BluetoothDevice d : bm.getConnectedDevices(BluetoothProfile.GATT)) extra.put(d.getAddress(), d);
            for (BluetoothDevice d : adapter.getBondedDevices()) if (d.getType() != BluetoothDevice.DEVICE_TYPE_CLASSIC) extra.put(d.getAddress(), d);
            for (BluetoothDevice d : extra.values()) {
                scanned.put(d.getAddress(), d);
                String n = d.getName() == null ? d.getAddress() : d.getName();
                dbg("Vinculado/conectado: " + n + " " + d.getAddress() + " tipo=" + d.getType());
                js("found", "{\"id\":\"" + d.getAddress() + "\",\"name\":\"" + n.replace("\"", "'").replace("\\", "") + " (vinculado)\",\"rssi\":0}");
            }
        } catch (Exception e) { dbg("No se pudo leer vinculados: " + e.getMessage()); }
        ScanSettings st = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        adapter.getBluetoothLeScanner().startScan(null, st, scanCb);
        scanning = true;
        // Búsqueda clásica en paralelo, solo para mostrar equipos "solo audio".
        try {
            if (!classicReg) { registerReceiver(classicRx, new android.content.IntentFilter(BluetoothDevice.ACTION_FOUND)); classicReg = true; }
            if (adapter.isDiscovering()) adapter.cancelDiscovery();
            adapter.startDiscovery();
        } catch (Exception e) { dbg("Búsqueda clásica no disponible: " + e.getMessage()); }
        ui.postDelayed(this::stopScanInt, 15000);
    }

    private void stopScanInt() {
        try { if (adapter != null && adapter.isDiscovering()) adapter.cancelDiscovery(); } catch (Exception ignored) { }
        if (scanning && adapter != null && adapter.getBluetoothLeScanner() != null) {
            try { adapter.getBluetoothLeScanner().stopScan(scanCb); } catch (Exception ignored) { }
        }
        scanning = false;
    }

    // ---------- GATT ----------
    private void closeGatt() {
        ready = false;
        if (gatt != null) {
            try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) { }
        }
        gatt = null;
        wrChar = null;
        synchronized (queue) { queue.clear(); writing = false; }
    }

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            dbg("GATT estado=" + state + " status=" + status + " intento=" + attempts);
            if (state == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                ui.postDelayed(() -> { if (!g.requestMtu(512)) g.discoverServices(); }, 600);
            } else {
                boolean wasReady = ready;
                try { g.close(); } catch (Exception ignored) { }
                if (g == gatt) gatt = null;
                wrChar = null;
                if (!wasReady && attempts < 5 && lastAddr != null) {
                    dbg("Reintentando conexión…");
                    ui.postDelayed(() -> doConnect(lastAddr), attempts == 1 ? 1500L : 800L);
                } else {
                    js("state", "disconnected");
                }
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int m, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) mtu = m;
            dbg("MTU=" + mtu);
            ui.postDelayed(g::discoverServices, 200);
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            StringBuilder sb = new StringBuilder("Servicios:");
            for (BluetoothGattService sv : g.getServices()) {
                sb.append(" ").append(sv.getUuid().toString(), 4, 8);
                for (BluetoothGattCharacteristic ch : sv.getCharacteristics())
                    sb.append("[").append(ch.getUuid().toString(), 4, 8).append(":").append(ch.getProperties()).append("]");
            }
            dbg(sb.toString());
            for (BluetoothGattService sv : g.getServices()) {
                dbg("SRV " + sv.getUuid());
                for (BluetoothGattCharacteristic ch : sv.getCharacteristics())
                    dbg("  CH " + ch.getUuid() + " prop=" + ch.getProperties());
            }
            BluetoothGattService s = g.getService(SERVICE);
            BluetoothGattCharacteristic nt = null;
            if (s != null) {
                wrChar = s.getCharacteristic(WRITE);
                nt = s.getCharacteristic(NOTIFY);
            } else {
                // Servicio alternativo: el primero (no estándar) que tenga escritura + notificación.
                for (BluetoothGattService sv : g.getServices()) {
                    String u = sv.getUuid().toString();
                    if (u.startsWith("00001800") || u.startsWith("00001801") || u.startsWith("0000180a")) continue;
                    BluetoothGattCharacteristic w = null, n = null;
                    for (BluetoothGattCharacteristic ch : sv.getCharacteristics()) {
                        int p = ch.getProperties();
                        if (w == null && (p & (BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0) w = ch;
                        if (n == null && (p & (BluetoothGattCharacteristic.PROPERTY_NOTIFY | BluetoothGattCharacteristic.PROPERTY_INDICATE)) != 0) n = ch;
                    }
                    if (w != null && n != null) { wrChar = w; nt = n; s = sv; break; }
                }
                if (s != null) dbg("Usando servicio alternativo " + s.getUuid());
            }
            if (s == null || wrChar == null || nt == null) {
                js("error", "Este equipo no es una placa compatible (falta el servicio de control).");
                g.disconnect();
                return;
            }
            g.setCharacteristicNotification(nt, true);
            BluetoothGattDescriptor d = nt.getDescriptor(CCCD);
            if (d != null) {
                boolean ind = (nt.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0;
                d.setValue(ind ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE : BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                g.writeDescriptor(d);
            } else {
                ready = true;
                js("state", "connected");
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            dbg("Notificaciones activadas status=" + status);
            ready = true;
            js("state", "connected");
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            android.util.Log.i("ZKAMP", "RX " + c.getUuid() + " " + hex(c.getValue()));
            js("data", hex(c.getValue()));
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            synchronized (queue) { writing = false; }
            pump();
        }
    };

    private void pump() {
        byte[] next;
        synchronized (queue) {
            if (writing || queue.isEmpty() || gatt == null || wrChar == null) return;
            next = queue.poll();
            writing = true;
        }
        wrChar.setValue(next);
        boolean noResp = (wrChar.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE) == 0;
        wrChar.setWriteType(noResp ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        if (noResp) {
            gatt.writeCharacteristic(wrChar);
            synchronized (queue) { writing = false; }
            ui.postDelayed(this::pump, 20);
            return;
        }
        if (!gatt.writeCharacteristic(wrChar)) {
            synchronized (queue) { writing = false; queue.addFirst(next); }
            ui.postDelayed(this::pump, 30);
        }
    }

    private void doConnect(String addr) {
        attempts++;
        try {
            BluetoothDevice d = scanned.get(addr);
            String how = "del escaneo";
            int first = Integer.parseInt(addr.substring(0, 2), 16);
            boolean randomAddr = (first & 0xC0) == 0xC0;
            if (Build.VERSION.SDK_INT >= 33 && randomAddr && (d == null || attempts == 2)) {
                d = adapter.getRemoteLeDevice(addr, android.bluetooth.BluetoothDevice.ADDRESS_TYPE_RANDOM);
                how = "dirección aleatoria";
            } else if (d == null) {
                d = adapter.getRemoteDevice(addr);
                how = "por dirección";
            }
            final BluetoothDevice dev = d;
            boolean auto = attempts >= 4;
            dbg("Intento " + attempts + " a " + addr + " (" + how + ", emparejado=" + bondName(dev.getBondState()) + ")");
            stopScanInt();
            if (attempts <= 4) {
                // Estrategia que funcionó: búsqueda cortada, pausa y conexión directa.
                dbg("Estrategia: búsqueda cortada, conexión directa");
                ui.postDelayed(() -> openGatt(dev, false), 1500);
            } else {
                dbg("Estrategia: auto-conectar (máximo 45 s)");
                ui.postDelayed(() -> {
                    if (!ready && lastAddr != null) { dbg("Auto-conectar: se agotó el tiempo"); closeGatt(); js("state", "disconnected"); }
                }, 45000);
                openGatt(dev, true);
            }
        } catch (Exception e) {
            js("error", "No se pudo conectar: " + e.getMessage());
        }
    }

    private void openGatt(BluetoothDevice d, boolean auto) {
        gatt = Build.VERSION.SDK_INT >= 23
                ? d.connectGatt(MainActivity.this, auto, gattCb, BluetoothDevice.TRANSPORT_LE)
                : d.connectGatt(MainActivity.this, auto, gattCb);
    }

    private void waitBond(BluetoothDevice d, int n) {
        int st = d.getBondState();
        if (st == BluetoothDevice.BOND_BONDED || n >= 30) {
            dbg("Emparejamiento: " + bondName(st));
            openGatt(d, false);
            return;
        }
        ui.postDelayed(() -> waitBond(d, n + 1), 500);
    }

    private static String bondName(int s) {
        return s == BluetoothDevice.BOND_BONDED ? "sí" : s == BluetoothDevice.BOND_BONDING ? "en curso" : "no";
    }

    private void startScanQuiet() {
        if (adapter == null || adapter.getBluetoothLeScanner() == null) return;
        try {
            ScanSettings st = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
            adapter.getBluetoothLeScanner().startScan(null, st, scanCb);
            scanning = true;
        } catch (Exception ignored) { }
    }

    // ---------- puente JS ----------
    private class Bridge {
        @JavascriptInterface
        public void scan() { ui.post(() -> withPerms(MainActivity.this::startScan)); }

        @JavascriptInterface
        public void stopScan() { ui.post(MainActivity.this::stopScanInt); }

        @JavascriptInterface
        public void connect(final String addr) {
            ui.post(() -> withPerms(() -> {
                closeGatt();
                attempts = 0;
                ready = false;
                lastAddr = addr;
                ui.postDelayed(() -> doConnect(addr), 400);
            }));
        }

        @JavascriptInterface
        public void log(String m) { android.util.Log.i("ZKAMP-UI", m); }

        @JavascriptInterface
        public void write(String h) {
            android.util.Log.i("ZKAMP", "TX " + h);
            byte[] data = unhex(h);
            int chunk = Math.max(20, mtu - 3);
            synchronized (queue) {
                for (int i = 0; i < data.length; i += chunk) {
                    int n = Math.min(chunk, data.length - i);
                    byte[] part = new byte[n];
                    System.arraycopy(data, i, part, 0, n);
                    queue.add(part);
                }
            }
            ui.post(MainActivity.this::pump);
        }

        @JavascriptInterface
        public void disconnect() { lastAddr = null; ready = false; ui.post(MainActivity.this::closeGatt); js("state", "disconnected"); }

        @JavascriptInterface
        public void openUrl(String url) {
            if (url == null || !url.startsWith("https://")) return;
            ui.post(() -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
        }
    }
}
