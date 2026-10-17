package com.luotianyi.run;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/** Bilibili web WBI parameter signing. Keys are fetched from /x/web-interface/nav. */
final class BiliWbiSigner {
    private static final int[] MIXIN_KEY_ENC_TAB = {
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
            27, 43, 5, 49, 33, 9, 48, 0, 12, 52, 26, 30, 55, 14, 22, 44,
            34, 1, 38, 24, 7, 6, 54, 29, 20, 28, 11, 25, 19, 36, 39, 40,
            21, 42, 13, 37, 57, 17, 56, 51, 16, 4, 41, 54, 55, 59
    };
    private static final Pattern FILTER = Pattern.compile("[^!-'*-._~]");

    private BiliWbiSigner() {}

    static String mixinKey(String imgKey, String subKey) {
        String raw = (imgKey == null ? "" : imgKey) + (subKey == null ? "" : subKey);
        StringBuilder out = new StringBuilder();
        for (int i : MIXIN_KEY_ENC_TAB) if (i < raw.length()) out.append(raw.charAt(i));
        return out.substring(0, Math.min(32, out.length()));
    }

    static String md5(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("MD5").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder s = new StringBuilder();
        for (byte b : digest) s.append(String.format(Locale.US, "%02x", b & 0xff));
        return s.toString();
    }

    static String encode(String value) {
        try {
            // Bilibili's wbi spec keeps these five characters percent-encoded.
            return java.net.URLEncoder.encode(value == null ? "" : value, "UTF-8")
                    .replace("+", "%20")
                    .replace("!", "%21").replace("'", "%27")
                    .replace("(", "%28").replace(")", "%29")
                    .replace("*", "%2A");
        } catch (Exception e) { return ""; }
    }

    static String signedQuery(Map<String, String> input, String mixinKey, long wts) throws Exception {
        Map<String, String> p = new HashMap<>(input);
        p.put("wts", String.valueOf(wts));
        List<String> keys = new ArrayList<>(p.keySet());
        Collections.sort(keys);
        StringBuilder query = new StringBuilder();
        for (String key : keys) {
            if (query.length() > 0) query.append('&');
            String val = FILTER.matcher(p.get(key) == null ? "" : p.get(key)).replaceAll("");
            query.append(encode(key)).append('=').append(encode(val));
        }
        return query + "&w_rid=" + md5(query + mixinKey);
    }
}
