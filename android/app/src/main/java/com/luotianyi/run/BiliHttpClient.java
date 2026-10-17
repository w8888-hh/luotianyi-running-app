package com.luotianyi.run;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Small, cookie-authenticated Bilibili web API client. */
final class BiliHttpClient {
    static final String BASE = "https://api.bilibili.com";
    private static final String NAV = BASE + "/x/web-interface/nav";
    private static final String PREFS = "bilibili_source";
    private static final String COOKIE_KEY = "cookie";
    private final SharedPreferences prefs;
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private volatile String imgKey;
    private volatile String subKey;

    BiliHttpClient(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    String getCookie() {
        String stored = prefs.getString(COOKIE_KEY, "");
        String session = sessionCookieHeader();
        if (stored.isEmpty()) return session;
        if (session.isEmpty()) return stored;
        // Merge: session cookies absorbed from Set-Cookie (buvid3 etc.) plus stored login.
        Map<String, String> merged = new java.util.LinkedHashMap<>();
        for (String part : stored.split(";")) {
            int eq = part.indexOf('=');
            if (eq > 0) merged.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
        }
        for (String part : session.split(";")) {
            int eq = part.indexOf('=');
            if (eq > 0) merged.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
        }
        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, String> e : merged.entrySet()) {
            if (out.length() > 0) out.append("; ");
            out.append(e.getKey()).append('=').append(e.getValue());
        }
        return out.toString();
    }
    void setCookie(String cookie) { prefs.edit().putString(COOKIE_KEY, cookie == null ? "" : cookie.trim()).apply(); }
    void clearCookie() { prefs.edit().remove(COOKIE_KEY).apply(); }
    void close() { executor.shutdownNow(); }

    interface Callback { void done(JSONObject value, String error); }

    void get(String path, Map<String, String> query, Callback callback) {
        get(path, query, true, callback);
    }

    /** retryAnonymous: a stale cookie makes the server reject an otherwise public request,
     *  so media resolution falls back to a cookie-less retry instead of failing. */
    void get(String path, Map<String, String> query, boolean retryAnonymous, Callback callback) {
        executor.execute(() -> {
            HttpURLConnection conn = null;
            String cookieHeaderUsed = "";
            try {
                StringBuilder u = new StringBuilder(BASE).append(path);
                if (query != null && !query.isEmpty()) {
                    u.append('?');
                    boolean first = true;
                    for (Map.Entry<String, String> e : query.entrySet()) {
                        if (!first) u.append('&');
                        first = false;
                        u.append(BiliWbiSigner.encode(e.getKey())).append('=').append(BiliWbiSigner.encode(e.getValue()));
                    }
                }
                conn = (HttpURLConnection) new URL(u.toString()).openConnection();
                conn.setConnectTimeout(12000);
                conn.setReadTimeout(18000);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
                conn.setRequestProperty("Referer", "https://www.bilibili.com/");
                String cookie = retryAnonymous ? getCookie() : "";
                if (!cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
                cookieHeaderUsed = cookie;
                // Search risk-control keys off buvid3; keep whatever the server sets.
                absorbSetCookies(conn);
                int code = conn.getResponseCode();
                InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String body = read(stream);
                if (code < 200 || code >= 300) { callback.done(null, "HTTP_" + code); return; }
                JSONObject json = new JSONObject(body);
                int apiCode = json.optInt("code", -1);
                if (apiCode != 0) {
                    if (apiCode == -101 || apiCode == -400) {
                        if (retryAnonymous && !cookieHeaderUsed.isEmpty()) {
                            // Retry once without the stale session cookie.
                            executor.execute(() -> get(path, query, false, callback));
                            return;
                        }
                        callback.done(json, "AUTH_EXPIRED");
                        return;
                    }
                    callback.done(json, "BILI_" + apiCode);
                    return;
                }
                callback.done(json, null);
            } catch (Exception e) {
                callback.done(null, "NETWORK_ERROR");
            } finally { if (conn != null) conn.disconnect(); }
        });
    }

    private static final String TV_APPKEY = "4409e2ce8ffd12b8";
    private static final String TV_APPSEC = "59b43e04ad6965f34319062b478f83dd";

    void qrCreate(Callback callback) {
        Map<String, String> form = new HashMap<>();
        form.put("appkey", TV_APPKEY);
        form.put("local_id", "0");
        form.put("ts", String.valueOf(System.currentTimeMillis() / 1000L));
        form.put("sign", tvSign(form));
        postPassport("/x/passport-tv-login/qrcode/auth_code", form, callback);
    }

    void qrPoll(String authCode, Callback callback) {
        Map<String, String> form = new HashMap<>();
        form.put("appkey", TV_APPKEY);
        form.put("local_id", "0");
        form.put("auth_code", authCode == null ? "" : authCode);
        form.put("ts", String.valueOf(System.currentTimeMillis() / 1000L));
        form.put("sign", tvSign(form));
        postPassport("/x/passport-tv-login/qrcode/poll", form, callback);
    }

    /** Signature covers appkey/local_id/ts(/auth_code) only; appsec never travels. */
    private static String tvSign(Map<String, String> params) {
        java.util.TreeMap<String, String> sorted = new java.util.TreeMap<>(params);
        StringBuilder raw = new StringBuilder();
        for (Map.Entry<String, String> e : sorted.entrySet()) {
            if ("sign".equals(e.getKey())) continue;
            if (raw.length() > 0) raw.append('&');
            raw.append(e.getKey()).append('=').append(e.getValue());
        }
        try { return BiliWbiSigner.md5(raw + TV_APPSEC); } catch (Exception e) { return ""; }
    }

    /** Server may hand login cookies back as Set-Cookie on the poll response. */
    private final Map<String, String> sessionCookies = new java.util.LinkedHashMap<>();

    private void absorbSetCookies(HttpURLConnection conn) {
        try {
            Map<String, java.util.List<String>> headers = conn.getHeaderFields();
            for (Map.Entry<String, java.util.List<String>> e : headers.entrySet()) {
                if (e.getKey() == null || !"set-cookie".equalsIgnoreCase(e.getKey())) continue;
                for (String cookie : e.getValue()) {
                    int eq = cookie.indexOf('=');
                    int semi = cookie.indexOf(';');
                    if (eq <= 0) continue;
                    String key = cookie.substring(0, eq).trim();
                    String value = cookie.substring(eq + 1, semi > eq ? semi : cookie.length()).trim();
                    if ("access_token".equals(key) && "deleted".equals(value)) continue;
                    sessionCookies.put(key, value);
                }
            }
        } catch (Throwable ignored) {}
    }

    String sessionCookieHeader() {
        if (sessionCookies.isEmpty()) return "";
        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, String> e : sessionCookies.entrySet()) {
            if (out.length() > 0) out.append("; ");
            out.append(e.getKey()).append('=').append(e.getValue());
        }
        return out.toString();
    }

    void mergeSessionCookies(String cookieHeader) {
        if (cookieHeader == null || cookieHeader.isEmpty()) return;
        for (String part : cookieHeader.split(";")) {
            int eq = part.indexOf('=');
            if (eq > 0) sessionCookies.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
        }
    }

    private void postPassport(String path, Map<String, String> params, Callback callback) {
        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                StringBuilder form = new StringBuilder();
                for (Map.Entry<String, String> e : params.entrySet()) {
                    if (form.length() > 0) form.append('&');
                    form.append(BiliWbiSigner.encode(e.getKey())).append('=').append(BiliWbiSigner.encode(e.getValue()));
                }
                conn = (HttpURLConnection) new URL("https://passport.bilibili.com" + path).openConnection();
                conn.setConnectTimeout(12000); conn.setReadTimeout(18000); conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
                conn.setRequestProperty("Referer", "https://www.bilibili.com/");
                try (java.io.OutputStream out = conn.getOutputStream()) { out.write(form.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
                absorbSetCookies(conn);
                int code = conn.getResponseCode();
                InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String body = read(stream);
                if (code < 200 || code >= 300) { callback.done(null, "HTTP_" + code); return; }
                callback.done(new JSONObject(body), null);
            } catch (Exception e) { callback.done(null, "NETWORK_ERROR"); }
            finally { if (conn != null) conn.disconnect(); }
        });
    }

    boolean isLoggedIn(JSONObject json) {
        JSONObject d = data(json);
        return d != null && d.optBoolean("isLogin", false) && d.optLong("mid", 0) > 0;
    }

    String currentCookie() { return getCookie(); }
    void restoreCookie(String cookie) { setCookie(cookie); }

    static String cookiesFromQr(JSONObject json) {
        try {
            JSONObject data = json.optJSONObject("data");
            JSONObject info = data == null ? null : data.optJSONObject("cookie_info");
            JSONArray list = info == null ? null : info.optJSONArray("cookies");
            if (list == null || list.length() == 0) return "";
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < list.length(); i++) {
                JSONObject c = list.optJSONObject(i); if (c == null) continue;
                String name = c.optString("name", ""), value = c.optString("value", "");
                if (name.isEmpty()) continue;
                if (out.length() > 0) out.append("; ");
                out.append(name).append('=').append(value);
            }
            return out.toString();
        } catch (Exception e) { return ""; }
    }

    void nav(Callback callback) {
        get("/x/web-interface/nav", null, (json, error) -> {
            if (error != null || json == null) { callback.done(json, error); return; }
            try {
                JSONObject data = json.optJSONObject("data");
                JSONObject wbi = data == null ? null : data.optJSONObject("wbi_img");
                String img = wbi == null ? "" : wbi.optString("img_url", "");
                String sub = wbi == null ? "" : wbi.optString("sub_url", "");
                imgKey = tailKey(img); subKey = tailKey(sub);
                callback.done(json, null);
            } catch (Exception e) { callback.done(null, "BAD_RESPONSE"); }
        });
    }

    /** Search risk-control needs buvid3; /x/frontend/finger/spi hands it out anonymously. */
    void ensureBuvid(Callback callback) {
        if (!sessionCookies.getOrDefault("buvid3", "").isEmpty()) { callback.done(null, null); return; }
        get("/x/frontend/finger/spi", null, false, (json, error) -> {
            if (error == null && json != null) {
                JSONObject d = data(json);
                if (d != null) {
                    String b3 = d.optString("b_3", ""), b4 = d.optString("b_4", "");
                    if (!b3.isEmpty()) sessionCookies.put("buvid3", b3);
                    if (!b4.isEmpty()) sessionCookies.put("buvid4", b4);
                }
            }
            callback.done(json, error);
        });
    }

    void signedGet(String path, Map<String, String> params, Callback callback) {
        if (imgKey != null && subKey != null) {
            doSignedGet(path, params, callback); return;
        }
        nav((ignored, error) -> {
            if (error != null || imgKey == null || subKey == null) {
                // No usable wbi keys: the endpoint still serves unsigned requests.
                get(path, params, callback);
                return;
            }
            doSignedGet(path, params, callback);
        });
    }

    private void doSignedGet(String path, Map<String, String> params, Callback callback) {
        try {
            String mix = BiliWbiSigner.mixinKey(imgKey, subKey);
            Map<String, String> p = params == null ? new HashMap<>() : new HashMap<>(params);
            long wts = System.currentTimeMillis() / 1000L;
            // Build the canonical query once: sort, filter, percent-encode, then hash it.
            java.util.TreeMap<String, String> sorted = new java.util.TreeMap<>(p);
            sorted.put("wts", String.valueOf(wts));
            StringBuilder canonical = new StringBuilder();
            for (Map.Entry<String, String> e : sorted.entrySet()) {
                if (canonical.length() > 0) canonical.append('&');
                canonical.append(BiliWbiSigner.encode(e.getKey())).append('=').append(BiliWbiSigner.encode(e.getValue()));
            }
            String wRid = BiliWbiSigner.md5(canonical + mix);
            Map<String, String> q = new HashMap<>(sorted);
            q.put("w_rid", wRid);
            get(path, q, callback);
        } catch (Exception e) { callback.done(null, "SIGN_ERROR"); }
    }

    static String tailKey(String url) {
        if (url == null) return "";
        String s = url.substring(url.lastIndexOf('/') + 1);
        int q = s.indexOf('?'); return q < 0 ? s : s.substring(0, q);
    }

    static String read(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder out = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(stream, java.nio.charset.StandardCharsets.UTF_8))) {
            String line; while ((line = r.readLine()) != null) out.append(line);
        }
        return out.toString();
    }

    static JSONObject data(JSONObject json) { return json == null ? null : json.optJSONObject("data"); }
}
