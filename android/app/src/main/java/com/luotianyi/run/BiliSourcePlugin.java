package com.luotianyi.run;

import android.content.Context;
import android.graphics.Bitmap;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.common.BitMatrix;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.Map;

/** Bilibili source: authenticated folders, tracks and current audio URLs. */
@CapacitorPlugin(name = "BiliSource")
public class BiliSourcePlugin extends Plugin {
    private static BiliSourcePlugin instance;
    private BiliHttpClient client;
    private final Object qrLock = new Object();
    private volatile String qrAuthCode;

    @Override public void load() { instance = this; client = new BiliHttpClient(getContext()); }
    @Override protected void handleOnDestroy() { if (instance == this) instance = null; if (client != null) client.close(); super.handleOnDestroy(); }

    @PluginMethod
    public void startQrLogin(PluginCall call) {
        synchronized (qrLock) { qrAuthCode = null; }
        client.qrCreate((json, error) -> {
            if (error != null || json == null) { call.reject(error == null ? "QR_CREATE_FAILED" : error); return; }
            int code = json.optInt("code", -1);
            JSONObject data = json.optJSONObject("data");
            String auth = data == null ? "" : data.optString("auth_code", "");
            String url = data == null ? "" : data.optString("url", "");
            if (code != 0 || auth.isEmpty() || url.isEmpty()) { call.reject("QR_CREATE_FAILED"); return; }
            synchronized (qrLock) { qrAuthCode = auth; }
            JSObject r = new JSObject(); r.put("qrUrl", qrDataUrl(url)); r.put("expiresIn", 180); call.resolve(r);
        });
    }

    private String qrDataUrl(String value) {
        try {
            EnumMap<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.MARGIN, 2);
            BitMatrix matrix = new MultiFormatWriter().encode(value, BarcodeFormat.QR_CODE, 420, 420, hints);
            Bitmap bitmap = Bitmap.createBitmap(matrix.getWidth(), matrix.getHeight(), Bitmap.Config.ARGB_8888);
            for (int y = 0; y < matrix.getHeight(); y++) for (int x = 0; x < matrix.getWidth(); x++) bitmap.setPixel(x, y, matrix.get(x, y) ? 0xFF111111 : 0xFFFFFFFF);
            ByteArrayOutputStream out = new ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.PNG, 100, out); bitmap.recycle();
            return "data:image/png;base64," + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Exception e) { return value; }
    }
    @PluginMethod
    public void pollQrLogin(PluginCall call) {
        String requested = call.getString("authCode", "");
        final String authCode;
        synchronized (qrLock) {
            if (qrAuthCode == null || (!requested.isEmpty() && !requested.equals(qrAuthCode))) { call.reject("QR_INVALID"); return; }
            authCode = qrAuthCode;
        }
        client.qrPoll(authCode, (json, error) -> {
            if (error != null || json == null) { call.reject(error == null ? "QR_POLL_FAILED" : error); return; }
            int code = json.optInt("code", -1);
            JSObject r = new JSObject(); r.put("code", code); r.put("message", json.optString("message", ""));
            if (code == 0) {
                String cookie = BiliHttpClient.cookiesFromQr(json);
                if (cookie.isEmpty()) cookie = client.sessionCookieHeader();
                if (cookie.isEmpty()) { call.reject("QR_NO_COOKIE"); return; }
                if (!client.sessionCookieHeader().isEmpty()) cookie = mergeCookies(cookie, client.sessionCookieHeader());
                String oldCookie = client.currentCookie();
                client.setCookie(cookie);
                client.nav((nav, navError) -> {
                    if (navError != null || !client.isLoggedIn(nav)) {
                        client.restoreCookie(oldCookie);
                        call.reject(navError != null ? navError : "AUTH_NOT_VERIFIED");
                        return;
                    }
                    synchronized (qrLock) { qrAuthCode = null; }
                    r.put("status", "verified");
                    JSONObject d = BiliHttpClient.data(nav);
                    if (d != null) { r.put("account", accountObject(d)); }
                    call.resolve(r);
                });
            } else if (code == 86038) {
                synchronized (qrLock) { qrAuthCode = null; }
                r.put("status", "expired"); call.reject("QR_EXPIRED");
            } else if (code == 86090 || code == 86039) {
                r.put("status", "scanned"); call.resolve(r);
            } else {
                r.put("status", "waiting"); call.resolve(r);
            }
        });
    }

    @PluginMethod
    public void cancelQrLogin(PluginCall call) { synchronized (qrLock) { qrAuthCode = null; } call.resolve(); }

    private static String mergeCookies(String a, String b) {
        java.util.LinkedHashMap<String, String> map = new java.util.LinkedHashMap<>();
        for (String header : new String[]{a, b}) {
            if (header == null) continue;
            for (String part : header.split(";")) {
                int eq = part.indexOf('=');
                if (eq > 0) map.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
            }
        }
        StringBuilder out = new StringBuilder();
        for (java.util.Map.Entry<String, String> e : map.entrySet()) {
            if (out.length() > 0) out.append("; ");
            out.append(e.getKey()).append('=').append(e.getValue());
        }
        return out.toString();
    }

    private JSObject accountObject(JSONObject d) {
        JSObject a = new JSObject(); a.put("loggedIn", d.optBoolean("isLogin", false));
        a.put("mid", d.optLong("mid", 0)); a.put("name", d.optString("uname", "哔哩哔哩用户")); a.put("avatar", d.optString("face", "")); return a;
    }

    @PluginMethod
    public void setCookie(PluginCall call) {
        String cookie = call.getString("cookie", "").trim();
        if (cookie.length() < 8 || !cookie.contains("=")) { call.reject("COOKIE_INVALID"); return; }
        client.setCookie(cookie);
        client.nav((json, error) -> {
            if (error != null) { client.clearCookie(); reject(call, error); return; }
            resolveAccount(call, json);
        });
    }

    @PluginMethod
    public void clearCookie(PluginCall call) { client.clearCookie(); call.resolve(); }

    @PluginMethod
    public void getAccount(PluginCall call) {
        if (client.getCookie().isEmpty()) { JSObject r = new JSObject(); r.put("loggedIn", false); call.resolve(r); return; }
        client.nav((json, error) -> {
            if (error != null) { reject(call, error); return; }
            resolveAccount(call, json);
        });
    }

    private void resolveAccount(PluginCall call, JSONObject json) {
        JSONObject d = BiliHttpClient.data(json);
        JSObject r = accountObject(d);
        call.resolve(r);
    }

    @PluginMethod
    public void listFavFolders(PluginCall call) {
        if (!requireCookie(call)) return;
        long requestedMid = call.getLong("mid", 0L);
        if (requestedMid > 0) { listFavFoldersRequest(call, requestedMid); return; }
        client.nav((nav, navError) -> {
            if (navError != null) { reject(call, navError); return; }
            JSONObject d = BiliHttpClient.data(nav);
            long mid = d == null ? 0 : d.optLong("mid", 0);
            if (mid <= 0 || !client.isLoggedIn(nav)) { reject(call, "AUTH_EXPIRED"); return; }
            listFavFoldersRequest(call, mid);
        });
    }

    private void listFavFoldersRequest(PluginCall call, long mid) {
        // list-all takes no paging params; passing them silently truncates the result.
        Map<String, String> q = new HashMap<>();
        q.put("up_mid", String.valueOf(mid));
        client.get("/x/v3/fav/folder/created/list-all", q, (json, error) -> {
            if (error != null) { reject(call, error); return; }
            try {
                JSONObject d = BiliHttpClient.data(json);
                JSONArray raw = d == null ? null : d.optJSONArray("list");
                // code:0 with data:null means not logged in / not self, not "no folders".
                if (raw == null) { reject(call, "AUTH_EXPIRED"); return; }
                JSArray out = new JSArray();
                for (int i = 0; i < raw.length(); i++) {
                    JSONObject x = raw.optJSONObject(i); if (x == null) continue;
                    JSObject f = new JSObject();
                    f.put("id", x.optLong("id", x.optLong("media_id", 0)));
                    f.put("title", x.optString("title", "未命名收藏夹"));
                    f.put("cover", x.optString("cover", ""));
                    f.put("count", x.optInt("media_count", 0));
                    f.put("intro", x.optString("intro", ""));
                    f.put("mtime", x.optLong("mtime", 0));
                    out.put(f);
                }
                JSObject r = new JSObject(); r.put("items", out); call.resolve(r);
            } catch (Exception e) { reject(call, "BAD_RESPONSE"); }
        });
    }

    @PluginMethod
    public void listFavItems(PluginCall call) {
        if (!requireCookie(call)) return;
        long mediaId = call.getLong("mediaId", 0L);
        if (mediaId <= 0) { call.reject("MEDIA_ID_REQUIRED"); return; }
        Map<String, String> q = new HashMap<>();
        q.put("media_id", String.valueOf(mediaId));
        q.put("pn", String.valueOf(Math.max(1, call.getInt("pn", 1))));
        q.put("ps", String.valueOf(Math.min(40, Math.max(1, call.getInt("ps", 20)))));
        q.put("keyword", call.getString("keyword", ""));
        q.put("order", call.getString("order", "mtime"));
        q.put("type", "0"); q.put("tid", "0"); q.put("platform", "web");
        client.get("/x/v3/fav/resource/list", q, (json, error) -> {
            if (error != null) { reject(call, error); return; }
            try {
                JSONObject d = BiliHttpClient.data(json);
                JSONArray raw = d == null ? new JSONArray() : d.optJSONArray("medias");
                JSArray out = new JSArray();
                if (raw != null) for (int i = 0; i < raw.length(); i++) {
                    JSONObject x = raw.optJSONObject(i); if (x == null || x.optInt("upper", 1) == 0) continue;
                    JSObject t = new JSObject();
                    t.put("bvid", x.optString("bvid", "")); t.put("aid", x.optLong("id", 0));
                    t.put("title", stripHtml(x.optString("title", "未命名视频")));
                    JSONObject upper = x.optJSONObject("upper");
                    String author = upper == null ? x.optString("upper", "") : upper.optString("name", "");
                    t.put("author", author); t.put("cover", x.optString("cover", ""));
                    t.put("duration", x.optInt("duration", 0)); t.put("cid", 0);
                    t.put("mediaId", mediaId); out.put(t);
                }
                JSObject r = new JSObject(); r.put("items", out);
                r.put("hasMore", d != null && d.optInt("has_more", 0) == 1);
                call.resolve(r);
            } catch (Exception e) { reject(call, "BAD_RESPONSE"); }
        });
    }

    @PluginMethod
    public void playAudio(PluginCall call) {
        String url = call.getString("url", "");
        if (url.isEmpty()) { call.reject("AUDIO_URL_EMPTY"); return; }
        android.content.Intent i = new android.content.Intent(getContext(), BiliMediaService.class)
                .setAction(BiliMediaService.ACTION_PLAY)
                .putExtra(BiliMediaService.EXTRA_URL, url)
                .putExtra(BiliMediaService.EXTRA_TITLE, call.getString("title", "哔哩哔哩音频"))
                .putExtra(BiliMediaService.EXTRA_ARTIST, call.getString("artist", "哔哩哔哩"));
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) getContext().startForegroundService(i);
            else getContext().startService(i);
            call.resolve();
        } catch (Throwable t) { call.reject("MEDIA_START_FAILED"); }
    }

    @PluginMethod
    public void pauseAudio(PluginCall call) { sendMediaAction(BiliMediaService.ACTION_PAUSE, call); }
    @PluginMethod
    public void resumeAudio(PluginCall call) { sendMediaAction(BiliMediaService.ACTION_RESUME, call); }
    @PluginMethod
    public void stopAudio(PluginCall call) { sendMediaAction(BiliMediaService.ACTION_STOP, call); }
    @PluginMethod
    public void seekAudio(PluginCall call) {
        android.content.Intent i = new android.content.Intent(getContext(), BiliMediaService.class)
                .setAction(BiliMediaService.ACTION_SEEK).putExtra(BiliMediaService.EXTRA_POSITION, call.getLong("position", 0L));
        try { getContext().startService(i); call.resolve(); } catch (Throwable t) { call.reject("MEDIA_ACTION_FAILED"); }
    }

    private void sendMediaAction(String action, PluginCall call) {
        try { getContext().startService(new android.content.Intent(getContext(), BiliMediaService.class).setAction(action)); call.resolve(); }
        catch (Throwable t) { call.reject("MEDIA_ACTION_FAILED"); }
    }

    static void dispatchMediaState(boolean playing, int playbackState, long position, long duration, String reason) {
        BiliSourcePlugin p = instance; if (p == null) return;
        android.app.Activity activity = p.getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            JSObject o = new JSObject(); o.put("playing", playing); o.put("state", playbackState);
            o.put("position", position); o.put("duration", duration); o.put("reason", reason);
            p.notifyListeners("mediaState", o);
        });
    }
    static void dispatchMediaError(String error) {
        BiliSourcePlugin p = instance; if (p == null) return;
        android.app.Activity activity = p.getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> { JSObject o = new JSObject(); o.put("error", error); p.notifyListeners("mediaError", o); });
    }

    @PluginMethod
    public void resolveAudio(PluginCall call) {
        // Public videos resolve without login; only folder browsing needs the cookie.
        String bvid = call.getString("bvid", ""); long aid = call.getLong("aid", 0L); long cid = call.getLong("cid", 0L);
        if (bvid.isEmpty() && aid <= 0) { call.reject("VIDEO_ID_REQUIRED"); return; }
        resolveCid(call, bvid, aid, cid);
    }

    private void resolveCid(PluginCall call, String bvid, long aid, long cid) {
        if (cid > 0) { signedPlayUrl(call, bvid, aid, cid); return; }
        Map<String, String> q = new HashMap<>();
        if (!bvid.isEmpty()) q.put("bvid", bvid); else q.put("aid", String.valueOf(aid));
        client.get("/x/web-interface/view", q, (json, error) -> {
            if (error != null) { reject(call, error); return; }
            try {
                JSONObject d = BiliHttpClient.data(json);
                JSONArray pages = d == null ? null : d.optJSONArray("pages");
                long found = pages != null && pages.length() > 0 ? pages.optJSONObject(0).optLong("cid", 0) : 0;
                if (found <= 0) { reject(call, "CID_NOT_FOUND"); return; }
                signedPlayUrl(call, bvid, aid, found);
            } catch (Exception e) { reject(call, "BAD_RESPONSE"); }
        });
    }

    @PluginMethod
    public void searchVideo(PluginCall call) {
        String keyword = call.getString("keyword", "").trim();
        if (keyword.isEmpty()) { call.reject("KEYWORD_REQUIRED"); return; }
        Map<String, String> q = new HashMap<>();
        q.put("search_type", "video");
        q.put("keyword", keyword);
        q.put("page", String.valueOf(Math.max(1, call.getInt("page", 1))));
        q.put("page_size", "20");
        client.ensureBuvid((ignored, ignoredErr) -> client.get("/x/web-interface/search/type", q, (json, error) -> {
            if (error != null) { reject(call, error); return; }
            try {
                JSONObject d = BiliHttpClient.data(json);
                JSONArray raw = d == null ? null : d.optJSONArray("result");
                JSArray out = new JSArray();
                if (raw != null) for (int i = 0; i < raw.length(); i++) {
                    JSONObject x = raw.optJSONObject(i); if (x == null) continue;
                    String bvid = x.optString("bvid", "");
                    if (bvid.isEmpty()) continue;
                    JSObject t = new JSObject();
                    t.put("bvid", bvid); t.put("aid", x.optLong("aid", 0));
                    t.put("title", stripHtml(x.optString("title", "")));
                    t.put("author", x.optString("author", ""));
                    t.put("cover", normalizeUrl(x.optString("pic", "")));
                    t.put("duration", parseDuration(x.optString("duration", "")));
                    t.put("cid", 0); out.put(t);
                }
                JSObject r = new JSObject(); r.put("items", out);
                r.put("page", call.getInt("page", 1));
                r.put("hasMore", out.length() >= 20);
                call.resolve(r);
            } catch (Exception e) { reject(call, "BAD_RESPONSE"); }
        }));
    }

    private static String normalizeUrl(String url) {
        if (url == null || url.isEmpty()) return "";
        return url.startsWith("//") ? "https:" + url : url;
    }

    /** Bilibili search returns "MM:SS" or "HH:MM:SS". */
    private static int parseDuration(String text) {
        if (text == null || text.isEmpty()) return 0;
        String[] parts = text.trim().split(":");
        try {
            int total = 0;
            for (String p : parts) total = total * 60 + Integer.parseInt(p.trim());
            return total;
        } catch (Exception e) { return 0; }
    }

    private void signedPlayUrl(PluginCall call, String bvid, long aid, long cid) {
        // Progressive stream (fnval=1): audio and video muxed into one URL. DASH audio
        // tracks need an init segment and separate handling; media players reject them.
        mediaUrl(call, bvid, aid, cid, 64, true);
    }

    private void mediaUrl(PluginCall call, String bvid, long aid, long cid, int qn, boolean retryLow) {
        Map<String, String> q = new HashMap<>();
        if (!bvid.isEmpty()) q.put("bvid", bvid); else q.put("avid", String.valueOf(aid));
        q.put("cid", String.valueOf(cid));
        q.put("qn", String.valueOf(qn));
        q.put("fnval", "1");
        q.put("fnver", "0");
        q.put("fourk", "1");
        client.signedGet("/x/player/wbi/playurl", q, (json, error) -> {
            if (error != null) { reject(call, error); return; }
            try {
                JSONObject d = BiliHttpClient.data(json);
                JSONArray durl = d == null ? null : d.optJSONArray("durl");
                String url = durl == null ? "" : muxedUrl(durl);
                if (url.isEmpty()) {
                    if (retryLow && qn != 32) { mediaUrl(call, bvid, aid, cid, 32, false); return; }
                    reject(call, "AUDIO_NOT_AVAILABLE"); return;
                }
                long duration = 0;
                if (durl != null && durl.optJSONObject(0) != null) duration = durl.optJSONObject(0).optLong("length", 0);
                JSObject r = new JSObject(); r.put("url", url); r.put("cid", cid);
                r.put("duration", duration); r.put("quality", qn); call.resolve(r);
            } catch (Exception e) { reject(call, "BAD_RESPONSE"); }
        });
    }

    /** Accept only a single muxed segment; several segments would truncate playback. */
    private static String muxedUrl(JSONArray durl) {
        if (durl == null || durl.length() != 1) return "";
        JSONObject seg = durl.optJSONObject(0); if (seg == null) return "";
        String url = seg.optString("url", "");
        if (!url.isEmpty()) return url;
        JSONArray backup = seg.optJSONArray("backup_url");
        if (backup != null) for (int i = 0; i < backup.length(); i++) {
            String b = backup.optString(i, ""); if (!b.isEmpty()) return b;
        }
        return "";
    }

    private boolean requireCookie(PluginCall call) {
        if (client.getCookie().isEmpty()) { call.reject("NOT_LOGGED_IN"); return false; }
        return true;
    }

    private void reject(PluginCall call, String error) { call.reject(error == null ? "BILI_ERROR" : error); }
    private static String stripHtml(String s) { return s == null ? "" : s.replaceAll("<[^>]+>", ""); }
}
