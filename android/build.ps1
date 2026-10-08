# Builds android\build\MixPairs.apk from ..\www and this folder, without Gradle.
# Usage:  .\build.ps1            build only
#         .\build.ps1 -Install   build, then install on the phone connected over USB
param([switch]$Install)

$ErrorActionPreference = 'Stop'
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$bt = "$sdk\build-tools\35.0.0" # 34's d8 crashes on class files from JDK 21
$jar = "$sdk\platforms\android-34\android.jar"
$here = $PSScriptRoot
$out = "$here\build"
# The same key must sign every build, or Android refuses the update and the saved mixes are lost with the uninstall.
$keystore = "$here\debug.keystore"

function Run($exe) {
    & $exe @args
    if ($LASTEXITCODE -ne 0) { throw "$(Split-Path $exe -Leaf) failed with exit code $LASTEXITCODE" }
}

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force "$out\classes" | Out-Null

if (-not (Test-Path $keystore)) {
    Run keytool -genkeypair -keystore $keystore -storepass android -keypass android -alias mixpairs `
        -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Mix Pairs"
}

Run "$bt\aapt2.exe" compile --dir "$here\res" -o "$out\res.zip"
Run "$bt\aapt2.exe" link -o "$out\unaligned.apk" -I $jar --manifest "$here\AndroidManifest.xml" -A "$here\..\www" "$out\res.zip"

Run javac -nowarn -source 11 -target 11 -classpath $jar -d "$out\classes" "$here\src\com\blake\mixpairs\MainActivity.java"
$classes = Get-ChildItem -Recurse "$out\classes" -Filter *.class | ForEach-Object FullName
Run "$bt\d8.bat" --lib $jar --min-api 26 --output $out @classes

Push-Location $out
try { Run "$bt\aapt.exe" add unaligned.apk classes.dex | Out-Null } finally { Pop-Location }

Run "$bt\zipalign.exe" -f 4 "$out\unaligned.apk" "$out\MixPairs.apk"
Run "$bt\apksigner.bat" sign --ks $keystore --ks-pass pass:android --key-pass pass:android "$out\MixPairs.apk"
Write-Host "Built $out\MixPairs.apk"

if ($Install) {
    Run adb install -r "$out\MixPairs.apk"
    Write-Host "Installed on the phone"
}
