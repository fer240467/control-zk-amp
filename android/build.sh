#!/bin/sh
# Compila el APK sin Gradle, con las herramientas del SDK de Android.
set -e
export JAVA_HOME="${JAVA_HOME:-C:\Program Files\Eclipse Adoptium\jdk-21.1.23.9-hotspot}"
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-/c/Android/Sdk}
BT=$SDK/build-tools/36.0.0
JAR=$SDK/platforms/android-36/android.jar
rm -rf out && mkdir -p out/classes out/dex assets/www
rm -rf assets/www && cp -r ../app assets/www
"$BT/aapt2.exe" compile --dir res -o out/res.zip
"$BT/aapt2.exe" link -o out/base.apk -I "$JAR" --manifest AndroidManifest.xml -A assets out/res.zip --java out/gen --min-sdk-version 23 --target-sdk-version 35 --version-code 13 --version-name 1.1.2
javac -source 11 -target 11 -nowarn -encoding UTF-8 -cp "$JAR" -d out/classes $(find src out/gen -name "*.java")
"$BT/d8.bat" --release --min-api 23 --lib "$JAR" --output out/dex $(find out/classes -name "*.class")
cp out/base.apk out/unsigned.apk
python -c "import zipfile; z=zipfile.ZipFile('out/unsigned.apk','a',zipfile.ZIP_DEFLATED); z.write('out/dex/classes.dex','classes.dex'); z.close()"
"$BT/zipalign.exe" -f -p 4 out/unsigned.apk out/aligned.apk
[ -f release.keystore ] || keytool -genkeypair -keystore release.keystore -alias zkamp -keyalg RSA -keysize 2048 -validity 10000 -storepass zkampstore -keypass zkampstore -dname "CN=Control ZK Amp, O=Control ZK Amp, C=UY" >/dev/null 2>&1
"$BT/apksigner.bat" sign --ks release.keystore --ks-key-alias zkamp --ks-pass pass:zkampstore --key-pass pass:zkampstore --out out/ControlZKAmp-1.1.2.apk out/aligned.apk
"$BT/apksigner.bat" verify out/ControlZKAmp-1.1.2.apk && echo "APK OK: out/ControlZKAmp-1.1.2.apk"
