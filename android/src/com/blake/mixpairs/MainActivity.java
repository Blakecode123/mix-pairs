package com.blake.mixpairs;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * Thin shell around the web app in assets. The files are served from a fixed https origin
 * (rather than file://) so IndexedDB and fetch() behave as they do in a browser.
 */
public class MainActivity extends Activity {
    private static final String TAG = "MixPairs";
    private static final boolean DEBUG = false;
    private static final String HOST = "appassets.androidplatform.net";
    private static final int REQ_SAVE_BACKUP = 1;
    private static final int REQ_PICK_FILE = 2;
    private static final int REQ_CAMERA = 3;

    private WebView web;
    private String pendingBackup;
    private ValueCallback<Uri[]> pendingFilePick;
    private PermissionRequest pendingCamera;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(0xFF12131A);
        getWindow().setNavigationBarColor(0xFF1C1E29);

        web = new WebView(this);
        web.setBackgroundColor(0xFF12131A);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false); // barcode scanner preview
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!HOST.equals(uri.getHost())) return null; // Discogs etc. go to the network
                String path = uri.getPath() == null || uri.getPath().equals("/") ? "index.html" : uri.getPath().substring(1);
                try {
                    return new WebResourceResponse(mimeType(path), "utf-8", getAssets().open(path));
                } catch (IOException e) {
                    Log.e(TAG, "asset not found: " + path);
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                }
            }
        });
        // Needed for confirm()/prompt() dialogs and for <input type="file">.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFilePick != null) pendingFilePick.onReceiveValue(null);
                pendingFilePick = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                startActivityForResult(pick, REQ_PICK_FILE);
                return true;
            }

            // The page asks for the camera for the barcode scanner; pass that on to Android's own permission prompt.
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                        request.deny();
                    } else if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
                    } else {
                        pendingCamera = request;
                        requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_CAMERA);
                    }
                });
            }
        });
        setContentView(web);

        if (state == null) web.loadUrl("https://" + HOST + "/");
        else web.restoreState(state);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        if (request != REQ_CAMERA || pendingCamera == null) return;
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (DEBUG) Log.d(TAG, "camera permission granted=" + granted);
        if (granted) pendingCamera.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        else pendingCamera.deny();
        pendingCamera = null;
    }

    // Back closes an open panel in the page first; only when there is none does it leave the app.
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("handleBack()", handled -> {
            if (!"true".equals(handled)) finish();
        });
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        Uri uri = result == RESULT_OK && data != null ? data.getData() : null;
        if (DEBUG) Log.d(TAG, "activity result " + request + " uri=" + uri);
        if (request == REQ_PICK_FILE) {
            if (pendingFilePick != null) pendingFilePick.onReceiveValue(uri == null ? null : new Uri[] { uri });
            pendingFilePick = null;
        } else if (request == REQ_SAVE_BACKUP) {
            if (uri != null && pendingBackup != null) writeBackup(uri);
            pendingBackup = null;
        }
    }

    private void writeBackup(Uri uri) {
        String message = "Backup saved";
        try (OutputStream out = getContentResolver().openOutputStream(uri)) {
            out.write(pendingBackup.getBytes(StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "backup write failed", e);
            message = "Could not save the backup";
        }
        web.evaluateJavascript("toast('" + message + "')", null);
    }

    private static String mimeType(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    /** Called from the page as window.Android.*; these arrive on a background thread. */
    private class Bridge {
        @JavascriptInterface
        public void saveBackup(String json, String fileName) {
            runOnUiThread(() -> {
                pendingBackup = json;
                Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/json")
                        .putExtra(Intent.EXTRA_TITLE, fileName);
                startActivityForResult(create, REQ_SAVE_BACKUP);
            });
        }

        @JavascriptInterface
        public void keepAwake(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }
}
